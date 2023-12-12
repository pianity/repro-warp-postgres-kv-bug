import ArLocal from "arlocal";
import { SmartWeaveGlobal, LoggerFactory, WarpFactory, Transaction } from "warp-contracts";
import { DeployPlugin, ArweaveSigner } from "warp-contracts-plugin-deploy";
import { PgSortKeyCache, PgSortKeyCacheOptions } from "warp-contracts-postgres";

LoggerFactory.INST.logLevel("error");

let SmartWeave: SmartWeaveGlobal;

type Erc20Action =
    | { function: "fundMe" }
    | { function: "transfer"; from?: string; target: string; quantity: number }
    | { function: "balanceOf"; target?: string };

const erc20Contract = (() => {
    async function handle(
        state: unknown,
        { input, caller }: { input: Erc20Action; caller: string },
    ): Promise<{ state: unknown } | { result: unknown }> {
        if (input.function === "fundMe") {
            const newBalance = (((await SmartWeave.kv.get(caller)) as number) ?? 0) + 1_000_000;
            await SmartWeave.kv.put(caller, newBalance);

            return { state };
        }

        if (input.function === "balanceOf") {
            const target = input.target ?? caller;
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
                await SmartWeave.kv.del(owner);
            } else {
                await SmartWeave.kv.put(owner, newOwnerBalance);
            }

            const newTargetBalance =
                (((await SmartWeave.kv.get(input.target)) as number) ?? 0) + input.quantity;
            await SmartWeave.kv.put(input.target, newTargetBalance);

            return { state };
        }

        throw new Error("Unknown function");
    }
    return handle.toString();
})();

type ProxyAction = { function: "transfer"; erc20: string; target: string; quantity: number };

const proxyContract = (() => {
    async function handle(
        state: unknown,
        action: { input: ProxyAction; caller: string },
    ): Promise<{ state: unknown } | { result: unknown }> {
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

    const warp = WarpFactory.forTestnet({ inMemory: true, dbLocation: "./cache/warp" }).use(
        new DeployPlugin(),
    );
    // .useKVStorageFactory((contractTxId) => new PgSortKeyCache(cacheOpts(contractTxId)));

    const { arweave } = warp;

    const wallet1 = await arweave.wallets.generate();
    const wallet1Addr = await arweave.wallets.jwkToAddress(wallet1);
    const wallet1Signer = new ArweaveSigner(wallet1);

    const erc20TxId = (
        await warp.deploy({
            wallet: wallet1Signer,
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
        .contract(erc20TxId)
        .setEvaluationOptions({ internalWrites: true, useKVStorage: true })
        .connect(wallet1);

    const proxyTxId = (
        await warp.deploy({
            wallet: wallet1Signer,
            initState: JSON.stringify({}),
            src: proxyContract,
            evaluationManifest: {
                evaluationOptions: {
                    useKVStorage: true,
                    internalWrites: true,
                },
            },
        })
    ).contractTxId;
    const proxy = warp
        .contract(proxyTxId)
        .setEvaluationOptions({ internalWrites: true, useKVStorage: true })
        .connect(wallet1);

    console.log((await erc20.viewState({ function: "balanceOf" } satisfies Erc20Action)).result);
    console.log(
        (await erc20.viewState({ function: "balanceOf", target: "bob" } satisfies Erc20Action))
            .result,
    );

    console.log("=== funding ===");

    await erc20.writeInteraction({ function: "fundMe" } satisfies Erc20Action, { strict: true });

    console.log("=== transfering to bob ===");

    await proxy.writeInteraction({
        function: "transfer",
        target: "bob",
        quantity: 100,
        erc20: erc20TxId,
    } satisfies ProxyAction);

    console.log((await erc20.viewState({ function: "balanceOf" } satisfies Erc20Action)).result);
    console.log(
        (await erc20.viewState({ function: "balanceOf", target: "bob" } satisfies Erc20Action))
            .result,
    );

    console.log("=== transfering from bob ===");

    await proxy.writeInteraction({
        function: "transfer",
        from: "bob",
        target: wallet1Addr,
        quantity: 100,
    } satisfies Erc20Action);

    console.log("=== reading result ===");

    console.log((await erc20.viewState({ function: "balanceOf" } satisfies Erc20Action)).result);
    console.log(
        (await erc20.viewState({ function: "balanceOf", target: "bob" } satisfies Erc20Action))
            .result,
    );
})();
