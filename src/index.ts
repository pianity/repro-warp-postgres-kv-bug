import { SmartWeaveGlobal, LoggerFactory, WarpFactory, Contract } from "warp-contracts";
import { DeployPlugin, ArweaveSigner } from "warp-contracts-plugin-deploy";
import { PgSortKeyCache, PgSortKeyCacheOptions } from "warp-contracts-postgres";

LoggerFactory.INST.logLevel("error");

let SmartWeave: SmartWeaveGlobal;

type ContractAction =
    | { function: "setMessage"; message: string }
    | { function: "removeMessage" }
    | { function: "getMessage" }
    | { function: "getMessageMap" };

const contractSrc = async function handle(
    state: unknown,
    { input, caller: _caller }: { input: ContractAction; caller: string },
): Promise<{ state: unknown } | { result: unknown }> {
    if (input.function === "setMessage") {
        await SmartWeave.kv.put("message", input.message);
        return { state };
    }

    if (input.function === "removeMessage") {
        await SmartWeave.kv.del("message");
        return { state };
    }

    if (input.function === "getMessage") {
        const message = await SmartWeave.kv.get("message");
        return { result: message };
    }

    if (input.function === "getMessageMap") {
        const message = await SmartWeave.kv.kvMap();
        return { result: message };
    }

    throw new Error("Unknown function");
};

async function readValues(contract: Contract) {
    console.log(
        (await contract.viewState({ function: "getMessage" } satisfies ContractAction)).result,
    );
    console.log(
        (await contract.viewState({ function: "getMessageMap" } satisfies ContractAction)).result,
    );
}

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

    const warp = WarpFactory.forTestnet({ inMemory: true, dbLocation: "./cache/warp" })
        .use(new DeployPlugin())
        .useKVStorageFactory((contractTxId) => new PgSortKeyCache(cacheOpts(contractTxId)));

    const { arweave } = warp;

    const wallet1 = await arweave.wallets.generate();
    const wallet1Signer = new ArweaveSigner(wallet1);

    const contractTxId = (
        await warp.deploy({
            wallet: wallet1Signer,
            initState: "{}",
            src: contractSrc.toString(),
            evaluationManifest: {
                evaluationOptions: {
                    useKVStorage: true,
                },
            },
        })
    ).contractTxId;
    const contract = warp
        .contract(contractTxId)
        .setEvaluationOptions({ useKVStorage: true })
        .connect(wallet1);

    console.log("=== initial ===");

    await readValues(contract);

    console.log("\n=== set message ===");

    await contract.writeInteraction(
        { function: "setMessage", message: "hello" } satisfies ContractAction,
        { strict: true },
    );

    await readValues(contract);

    console.log("\n=== overwrite message ===");

    await contract.writeInteraction(
        { function: "setMessage", message: "world" } satisfies ContractAction,
        { strict: true },
    );

    await readValues(contract);

    console.log("\n=== remove message ===");

    await contract.writeInteraction({ function: "removeMessage" } satisfies ContractAction, {
        strict: true,
    });

    await readValues(contract);
})();
