import type { Address } from "viem";

import { TOKEN_POOL_PAIRS_V4_EXPORT, TRITON_V4_TOKEN_ADDRESS_ARRAY } from "../action-providers/coingecko-action-provider";
import { TRITON_WETH_ADDRESS } from "./triton-config";

/** Display names for Triton V4 tokens (keys = lowercase checksummed address). */
const V4_TOKEN_NAMES_BY_ADDRESS: Record<string, string> = {
  "0xde61878b0b21ce395266c44d4d548d1c72a3eb07": "sairi",
  "0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3": "miroshark",
  "0x62abe92f50c518165a5c010fe59f35023197fba3": "edge",
  "0x316ffb9c875f900adcf04889e415cc86b564eba3": "litcoin",
  "0x3722264ab15a1dfce5a5af89e6547f7949a8aba3": "lienfi",
  "0x16332535e2c27da578bc2e82beb09ce9d3c8eb07": "clawbank",
  "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3": "gitlawb",
  "0xab3f23c2abcb4e12cc8b593c218a7ba64ed17ba3": "helixacred",
  "0xa1f72459dfa10bad200ac160ecd78c6b77a747be": "clawnch",
  "0xb695559b26bb2c9703ef1935c37aeae9526bab07": "moltbook",
  "0xb233bdffd437e60fa451f62c6c09d3804d285ba3": "nook",
  "0x95ccfd2b81a9667b0cc979992632f98fc853eba3": "hermesos",
  "0x50d2280441372486beecdd328c1854743ebacb07": "kellyclaude",
  "0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07": "juno",
  "0x00cb1fbca324d51325a7264d54072bc073c28ba3": "darksol",
  "0xf27b8ef47842e6445e37804896f1bc5e29381b07": "doppel",
  "0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07": "felix",
  "0xd88fd4a11255e51f64f78b4a7d74456325c2d8dc": "bitvault",
  "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07": "clawd",
  "0x59c0d5c34c301ac0600147924d6c9be22a2f0b07": "molten",
  "0xa601877977340862ca67f816eb079958e5bd0ba3": "botcoin",
  "0x6f89bca4ea5931edfcb09786267b251dee752b07": "regent",
  "0x9ae5f51d81ff510bf961218f833f79d57bfbab07": "selfclaw",
  "0x3977fc913db86b01a257232c568317798b903b07": "cody",
  "0xc21dd0ee043930711c2a3e55f39c7d3144d09b07": "gitbank",
  "0x572c4fa77623652411574c51b5ddb7e1b750aba3": "supergemma4",
  "0x753f2af0f46361c9ae6fc347797f99b0c9e82ba3": "grantr",
  "0x721b072dbb616f29eea73ac004e03fd4e884bba3": "evo",
};

const V4_NAME_ALIASES: Record<string, string> = {
  weth: TRITON_WETH_ADDRESS.toLowerCase(),
  hermes: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
  helixa: "0xab3f23c2abcb4e12cc8b593c218a7ba64ed17ba3",
  gitlaw: "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3",
};

export type TritonV4TokenRef = {
  name: string;
  address: Address;
  poolAddress: string;
};

function normalizeTokenNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const V4_BY_NORMALIZED_NAME = (() => {
  const map = new Map<string, TritonV4TokenRef>();
  for (const pair of TOKEN_POOL_PAIRS_V4_EXPORT) {
    const addr = pair.tokenAddress.toLowerCase();
    const name = V4_TOKEN_NAMES_BY_ADDRESS[addr] ?? addr.slice(0, 10);
    const ref: TritonV4TokenRef = {
      name,
      address: pair.tokenAddress as Address,
      poolAddress: pair.poolAddress,
    };
    map.set(normalizeTokenNameKey(name), ref);
  }
  for (const [alias, addr] of Object.entries(V4_NAME_ALIASES)) {
    const pair = TOKEN_POOL_PAIRS_V4_EXPORT.find((p) => p.tokenAddress === addr);
    if (pair) {
      map.set(normalizeTokenNameKey(alias), {
        name: V4_TOKEN_NAMES_BY_ADDRESS[addr] ?? alias,
        address: pair.tokenAddress as Address,
        poolAddress: pair.poolAddress,
      });
    } else if (alias === "weth") {
      map.set("weth", {
        name: "weth",
        address: TRITON_WETH_ADDRESS as Address,
        poolAddress: "",
      });
    }
  }
  return map;
})();

/** All named Triton V4 tokens for chat autocomplete / list tools. */
export function listTritonV4Tokens(): TritonV4TokenRef[] {
  return TRITON_V4_TOKEN_ADDRESS_ARRAY.map((addr) => {
    const lc = addr.toLowerCase();
    const pair = TOKEN_POOL_PAIRS_V4_EXPORT.find((p) => p.tokenAddress === lc);
    return {
      name: V4_TOKEN_NAMES_BY_ADDRESS[lc] ?? lc.slice(0, 10),
      address: addr as Address,
      poolAddress: pair?.poolAddress ?? "",
    };
  });
}

export function resolveTritonV4Token(input: string): TritonV4TokenRef | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(raw)) {
    const lc = raw.toLowerCase();
    if (lc === TRITON_WETH_ADDRESS.toLowerCase()) {
      return { name: "weth", address: TRITON_WETH_ADDRESS as Address, poolAddress: "" };
    }
    const pair = TOKEN_POOL_PAIRS_V4_EXPORT.find((p) => p.tokenAddress === lc);
    if (!pair) return null;
    return {
      name: V4_TOKEN_NAMES_BY_ADDRESS[lc] ?? lc.slice(0, 10),
      address: pair.tokenAddress as Address,
      poolAddress: pair.poolAddress,
    };
  }
  const key = normalizeTokenNameKey(raw);
  return V4_BY_NORMALIZED_NAME.get(key) ?? null;
}

export function tokenNameForAddress(address: string): string | null {
  const lc = address.trim().toLowerCase();
  if (lc === TRITON_WETH_ADDRESS.toLowerCase()) return "weth";
  return V4_TOKEN_NAMES_BY_ADDRESS[lc] ?? null;
}
