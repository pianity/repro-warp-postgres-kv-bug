import { readFileSync } from "node:fs";

import ArLocal from "arlocal";
import { SmartWeaveGlobal, LoggerFactory, WarpFactory, Transaction } from "warp-contracts";
import { DeployPlugin, ArweaveSigner } from "warp-contracts-plugin-deploy";
import { PgSortKeyCache, PgSortKeyCacheOptions } from "warp-contracts-postgres";
// import { ArweaveSigner } from "warp-arbundles";

// const ArLocal = (ArLocalBuggy as any).default as ArLocalBuggy;

// export default class ArweaveSigner implements Signer {
//     readonly signatureType: number = 1;
//     readonly ownerLength: number = SIG_CONFIG[1].pubLength;
//     readonly signatureLength: number = SIG_CONFIG[1].sigLength;
//     protected jwk: JWKInterface;
//     public pk: string;
//
//     constructor(jwk: JWKInterface) {
//         this.pk = jwk.n;
//         this.jwk = jwk;
//     }
//
//     get publicKey(): Buffer {
//         return base64url.toBuffer(this.pk);
//     }
//
//     sign(message: Uint8Array): Uint8Array {
//         return getCryptoDriver().sign(this.jwk, message) as any;
//     }
//
//     static async verify(pk: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
//         return await getCryptoDriver().verify(pk, message, signature);
//     }
// }

LoggerFactory.INST.logLevel("error");

let SmartWeave: SmartWeaveGlobal;

type Erc20State = {};
type Erc20Action =
    | { function: "fundMe" }
    | { function: "transfer"; from?: string; target: string; quantity: number }
    | { function: "balanceOf"; target?: string };

const erc20Contract = (() => {
    async function handle(
        state: Erc20State,
        { input, caller }: { input: Erc20Action; caller: string },
    ): Promise<{ state: Erc20State } | { result: unknown }> {
        if (input.function === "fundMe") {
            const newBalance = (((await SmartWeave.kv.get(caller)) as number) ?? 0) + 1_000_000;
            await SmartWeave.kv.put(caller, newBalance);

            return { state };
        }

        if (input.function === "balanceOf") {
            const target = input.target ?? caller;

            // console.log(`[debug] ${target}: ${await SmartWeave.kv.get(target)}`);

            const balance = ((await SmartWeave.kv.get(target)) as number) ?? 0;

            return { result: [target, balance] };
        }

        if (input.function === "transfer") {
            const owner = input.from ?? caller;
            const ownerBalance = ((await SmartWeave.kv.get(owner)) as number) ?? 0;
            if (ownerBalance < input.quantity) {
                throw new Error("Not enough balance");
            }
            const newOwnerBalance = ownerBalance - input.quantity;
            if (newOwnerBalance === 0) {
                console.log(`[debug] deleting ${owner}`);
                await SmartWeave.kv.del(owner);
            } else {
                await SmartWeave.kv.put(owner, newOwnerBalance);
            }

            const newTargetBalance =
                (((await SmartWeave.kv.get(input.target)) as number) ?? 0) + input.quantity;
            await SmartWeave.kv.put(input.target, newTargetBalance);

            console.log("OWNER", owner);
            console.log("NEW BALANCE", await SmartWeave.kv.get(input.target));

            return { state };
        }

        throw new Error("Unknown function");
    }
    return handle.toString();
})();

type TestState = {};
type TestAction = { function: "transfer"; erc20: string; target: string; quantity: number };

const testContract = (() => {
    async function handle(
        state: TestState,
        action: { input: TestAction; caller: string },
    ): Promise<{ state: TestState } | { result: unknown }> {
        if (action.input.function === "transfer") {
            const transferInput: Erc20Action = {
                function: "transfer",
                from: action.caller,
                target: action.input.target,
                quantity: action.input.quantity,
            };
            await SmartWeave.contracts.write(action.input.erc20, transferInput);

            return { state };
        }

        throw new Error("Unknown function");
    }

    return handle.toString();
})();

(async () => {
    const cacheOpts = (tableName: string): PgSortKeyCacheOptions => ({
        tableName,
        host: "localhost",
        port: 5432,
        database: "warp",
        user: "warp",
        schemaName: "warpschema",
        minEntriesPerKey: 1,
        maxEntriesPerKey: 10000,
    });

    // const warp = WarpFactory.forTestnet({ inMemory: true, dbLocation: "./cache/warp" }).use(
    //     new DeployPlugin(),
    // );
    // // .useKVStorageFactory((contractTxId) => new PgSortKeyCache(cacheOpts(contractTxId)));

    const arlocal = new (ArLocal as any).default(1987, false) as ArLocal;
    await arlocal.start();
    const warp = WarpFactory.forLocal(1987, undefined, {
        inMemory: true,
        dbLocation: "/dev/null",
    }).use(new DeployPlugin());
    // .useKVStorageFactory((contractTxId) => new PgSortKeyCache(cacheOpts(contractTxId)));

    const { arweave } = warp;

    const wallet1 = await arweave.wallets.generate();
    const wallet1Addr = await arweave.wallets.jwkToAddress(wallet1);
    await warp.testing.addFunds(wallet1);

    const signer = new ArweaveSigner(wallet1);

    // const erc20InitState: Erc20State = {
    //     balances: { [walletArbankAddr]: 1_000_000 },
    // };
    const erc20TxId = (
        await warp.deploy({
            wallet: wallet1,
            // wallet: signer,
            initState: JSON.stringify({}),
            src: erc20Contract,
            evaluationManifest: {
                evaluationOptions: {
                    internalWrites: true,
                    useKVStorage: true,
                },
            },
        })
    ).contractTxId;
    const erc20 = warp
        .contract<Erc20State>(erc20TxId)
        .setEvaluationOptions({ internalWrites: true, useKVStorage: true })
        .connect(wallet1);

    const testTxId = (
        await warp.deploy({
            wallet: wallet1,
            // wallet: signer,
            initState: JSON.stringify({}),
            src: testContract,
            evaluationManifest: {
                evaluationOptions: {
                    useKVStorage: true,
                    internalWrites: true,
                },
            },
        })
    ).contractTxId;
    const test = warp
        .contract(testTxId)
        .setEvaluationOptions({ internalWrites: true, useKVStorage: true })
        .connect(wallet1);

    console.log((await erc20.viewState({ function: "balanceOf" } satisfies Erc20Action)).result);
    console.log(
        (await erc20.viewState({ function: "balanceOf", target: "bob" } satisfies Erc20Action))
            .result,
    );

    console.log("funding");

    await erc20.writeInteraction({ function: "fundMe" } satisfies Erc20Action, { strict: true });

    console.log("transfer to bob");

    await test.writeInteraction({
        function: "transfer",
        target: "bob",
        quantity: 100,
        erc20: erc20TxId,
    } satisfies TestAction);

    console.log((await erc20.viewState({ function: "balanceOf" } satisfies Erc20Action)).result);
    console.log(
        (await erc20.viewState({ function: "balanceOf", target: "bob" } satisfies Erc20Action))
            .result,
    );

    console.log("transfer from bob");

    await test.writeInteraction({
        function: "transfer",
        from: "bob",
        target: wallet1Addr,
        quantity: 100,
    } satisfies Erc20Action);

    console.log("reading result");

    // await erc20.readState();
    // await test.readState();

    console.log((await erc20.viewState({ function: "balanceOf" } satisfies Erc20Action)).result);
    console.log(
        (await erc20.viewState({ function: "balanceOf", target: "bob" } satisfies Erc20Action))
            .result,
    );

    await arlocal.stop();
})();
