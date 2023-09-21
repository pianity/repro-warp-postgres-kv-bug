import { LoggerFactory, WarpFactory } from "warp-contracts/mjs";
import { DeployPlugin, ArweaveSigner } from "warp-contracts-plugin-deploy";

LoggerFactory.INST.logLevel("debug");

type State = { count: number };
type Action = { function: "plus-one" } | { function: "transfer"; target: string; qty: string };

function handle(
    state: State,
    action: { input: Action; caller: string },
): { state: State } | { result: unknown } {
    if (action.input.function === "plus-one") {
        state.count += 1;
    }

    return { state };
}

const warp = WarpFactory.forMainnet({
    inMemory: true,
    dbLocation: "./warp-cache",
}).use(new DeployPlugin());
const { arweave } = warp;

const wallet = await arweave.wallets.generate();

console.log("wallet address:", await arweave.wallets.jwkToAddress(wallet));

const initState: State = { count: 0 };
const { contractTxId } = await warp.deploy({
    wallet: new ArweaveSigner(wallet),
    src: handle.toString(),
    initState: JSON.stringify(initState),
});

console.log("contract tx id:", contractTxId);

const contract = warp.contract<State>(contractTxId).connect(wallet);

console.log("reading state");
console.log(await contract.readState());

console.log("writing interaction");
console.log(await contract.writeInteraction("plus-one", { strict: false }));
