import { customActionProvider } from "@coinbase/agentkit";
import { z } from "zod";
import {
  getRankingEligibilityThresholds,
  type FloatRankingProfile,
  type RankingEligibilityThresholds,
} from "../config/ranking-eligibility";
import {
  computeMarketH24BreadthFromTokenSummary,
  getTokenRankingMetrics,
  getOffensiveTokenRankingMetrics,
  TOKEN_RANKING_METRICS,
  offensiveMomentumExcludeReason,
  passesOffensiveMomentumGates,
  type OffensiveMomentumExcludeContext,
  STABLE_USDC_WETH_PAIR,
  STABLE_V4_WETH_ADDRESS,
  type MarketBreadthStableMode,
  type TokenRankingMetricsMap,
  resolveWeightedScoreBaseline,
  resolveWeightedScoreBounds,
  passesVolatilityH24Band,
} from "../config/demeter-config";
import { loadDemeterEnv } from "../config/demeter-loops";
import { COINGECKO_NETWORK } from "../config/chain-config";

export { getTokenRankingMetrics, TOKEN_RANKING_METRICS };

loadDemeterEnv();

/** 
 * CoinGecko Action Provider
 * 
 * Provides actions for fetching cryptocurrency price data from CoinGecko API.
 * This enables Demeter to make informed decisions based on current market prices.
 */

/** Read at request time — import-time snapshot missed keys loaded after coingecko module init. */
function coinGeckoApiKey(): string {
  loadDemeterEnv();
  return process.env.COIN_GECKO_API_KEY?.trim() ?? "";
}

function requireCoinGeckoApiKey(): string {
  const key = coinGeckoApiKey();
  if (!key) {
    throw new Error("COIN_GECKO_API_KEY is required in environment variables");
  }
  return key;
}

function coinGeckoHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    "x-cg-pro-api-key": requireCoinGeckoApiKey(),
  };
}

function formatCoinGeckoHttpError(
  status: number,
  statusText: string,
  endpoint: string,
  responseBody?: string
): string {
  const bodyHint = responseBody?.trim()
    ? ` Body: ${responseBody.trim().slice(0, 240)}`
    : "";
  if (status !== 401) {
    return `CoinGecko API error (${endpoint}): ${status} ${statusText}${bodyHint}`;
  }
  const key = coinGeckoApiKey();
  const prefix = key.length >= 7 ? `${key.slice(0, 7)}…` : key ? "(short)" : "(empty)";
  return (
    `CoinGecko API error (${endpoint}): ${status} ${statusText}. ` +
    `Key len=${key.length}, prefix=${prefix}.${bodyHint} ` +
    "Smoke test uses 1 token; Demeter Float V4 batches many — if smoke is 200 but Demeter fails, deploy chunked multi fetch or run `npx tsx scripts/coingecko-api-smoke.ts v4-full`."
  );
}

/** Uniswap V3 pairs on Base (20-byte pool contract addresses). CoinGecko onchain pool APIs use these addresses. */
type TokenPoolPair = {
  tokenAddress: string;
  poolAddress: string; // hard-coded pool address for this token
};

/** Uniswap V4 pairs on Base (bytes32 pool id for CoinGecko; poolKey for on-chain LiquidStratMin). */
export type V4PoolKey = {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
};

export type TokenPoolPairV4 = {
  tokenAddress: string;
  poolAddress: string;
  poolKey: V4PoolKey;
};
// 25 spots: slots 1-13 use your existing tokens; 14-25 are TODO placeholders.
const TOKEN_POOL_PAIRS: TokenPoolPair[] = [
  
  // 1 - $2.80M Liquidity  Volitility 0.0326 2 Mil Liquidity 80K 24h Volume
  { tokenAddress: "0x1bc0c42215582d5a085795f4badbac3ff36d1bcb", poolAddress: "0xc1a6fbedae68e1472dbb91fe29b51f7a0bd44f97" },

  // 2 - $2.44M Liquidity  Volitility 0.2650  L - $2.43M V - 644.12K
  { tokenAddress: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b", poolAddress: "0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703" },

  // 3 Fair- $277.97K Liquidity  Volitility 0.1328  L - 78.65K V - 37.01K
  { tokenAddress: "0x7d928816cc9c462dd7adef911de41535e444cb07", poolAddress: "0xfc01837343cfc2a9ddca9e8a0a19825f6b2f0460" },
  // 4 - $40K
  // { tokenAddress: "0xa1f72459dfa10bad200ac160ecd78c6b77a747be", poolAddress: "0x07da9c5d35028f578dfac5be6e5aaa8a835704f6" },

  // 5 -noice $322K Liquidity  Volitility 0.0942l -358.33K V - 33.77K
  { tokenAddress: "0x9cb41fd9dc6891bae8187029461bfaadf6cc0c69", poolAddress: "0xeff7f8fe083d7a446717b992bf84391253e54789" },

  // 6 $52.73K Liquidity  Volitility 0.4649
  // { tokenAddress: "0x290f057a2c59b95d8027aa4abf31782676502071", poolAddress: "0x76c0106bba123e9b32770b2b34b6d13bf4cfa933" },

  // 7 clawd $208.54K Liquidity   Volitility 0.0292 l -1.15M V - 33.62K
  // { tokenAddress: "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07", poolAddress: "0xcd55381a53da35ab1d7bc5e3fe5f76cac976fac3" },

  // 8 REI 359.09K Liquidity  Volitility 0.1390
  { tokenAddress: "0x6b2504a03ca4d43d0d73776f6ad46dab2f2a4cfd", poolAddress: "0xa213c82265cd3d94f972f735a4f5130e34df81bc" },

  // 9 AMETA  $138.63K Liquidity  Volitility 0.2541
  // { tokenAddress: "0x90ec58ef4cc9f37b96de1e203b65bd4e6e79580e", poolAddress: "0xfb559d225343a61884d46eee91c1a805759f758b" },

  // 10 DRB $793.47K Liquidity  Volitility 0.1341 
  { tokenAddress: "0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2", poolAddress: "0x5116773e18a9c7bb03ebb961b38678e45e238923" },

  // 11  VVV $146.21K Liquidity Volitility 0.7916
  // { tokenAddress: "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf", poolAddress: "0x1d2bdb7117a5a7d7fe4c1d95681a92e4df13bb69" },

  // 12 - FAI $256.02K Liquidity     Volitility 0.0173
  { tokenAddress: "0xb33ff54b9f7242ef1593d2c9bcd8f9df46c77935", poolAddress: "0x68b27e9066d3aadc6078e17c8611b37868f96a1d" },

  // 13 - AUKI 389.08K Liquidity Volitilit 0.1583
  { tokenAddress: "0xf9569cfb8fd265e91aa478d86ae8c78b8af55df4", poolAddress: "0x2fa9d6085c91151200e61a3e627d35001772c0d1" },

  // 14 - $90.94K Liquidity Volitility 0.4649
  // { tokenAddress: "0xd20ab1015f6a2de4a6fddebab270113f689c2f7c", poolAddress: "0xebdeacaf03ba54eb18128fd1fd042bc747af9295" },

  // 16 - $10.19K Volitility 0.4649
  // { tokenAddress: "0x767a739d1a152639e9ea1d8c1bd55fdc5b217d7f", poolAddress: "0x7f1a5b66ba3bb56c4b68cfc353a5e041c9763a4c" },

  // 18 - PARTI $324.79K Liquidity Volitility 0.4649
  { tokenAddress: "0x59264f02d301281f3393e1385c0aefd446eb0f00", poolAddress: "0x9c42751954513c0461481a9600c9d11a059ddd12" },

  // 19 - Circle $213.44K Liquidity Volitility 0.0255
  { tokenAddress: "0x5babfc2f240bc5de90eb7e19d789412db1dec402", poolAddress: "0xda679706ff21114ac9fac5198bff24543f357a16" },

  // 20 - doginime $1.36M Liquidity Volitility 0.0401
  { tokenAddress: "0x6921b130d297cc43754afba22e5eac0fbf8db75b", poolAddress: "0xade9bcd4b968ee26bed102dd43a55f6a8c2416df" },

  // 21  - $268.93K Liquidity Volitility 0.4649
  { tokenAddress: "0x2f6c17fa9f9bc3600346ab4e48c0701e1d5962ae", poolAddress: "0xfdbaf04326acc24e3d1788333826b71e3291863a" },

  // 22 - ZFI $212.73K Liquidity Volitility 0.0199
  { tokenAddress: "0xd080ed3c74a20250a2c9821885203034acd2d5ae", poolAddress: "0xc6f63e4bea6682aa502ed94c1301b56230fc03d2" },

  // 23 QR $130.57K Liquidity Volitility 0.0126
  // { tokenAddress: "0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf", poolAddress: "0xf02c421e15abdf2008bb6577336b0f3d7aec98f0" },

  // 24 - $33.99K Liquidity Volitility 0.0080
  // { tokenAddress: "0xf0197f10ea542a67914ecc0ec5304dc9df1faf6f", poolAddress: "0xba9d9445e0abdb6764ad6923feb04f12e863a616" },

    // 24 - FLUID $252.95K Liquidity    Volitility 0.0922
    { tokenAddress: "0x61e030a56d33e8260fdd81f03b162a79fe3449cd", poolAddress: "0x3b3d1a85a248b70100e95437dbeebcae5e7ec7a1" },

  // 24 - Toshi 1.42M Liquidity    Volitility 0.0172
  { tokenAddress: "0xac1bd2486aaf3b5c0fc3fd868558b082a531b2b4", poolAddress: "0x4b0aaf3ebb163dd45f663b38b6d93f6093ebc2d3" },

  // 24 - Flayer $238.35K Liquidity    Volitility 0.0094
  { tokenAddress: "0xf1a7000000950c7ad8aff13118bb7ab561a448ee", poolAddress: "0x7b9fda92bfa6fdadfdc4f6c72c0cc8336e7d7497" },
];

const TOKEN_POOL_PAIRS_V4: TokenPoolPairV4[] = [
  // 1 - $507.81K Liquidity - 1% Fee - SAIRI 2.4K Holders 24h Volume 116K USD Volitility 0.2375
  // 0xde61878b0b21ce395266c44d4d548d1c72a3eb07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xde61878b0b21ce395266c44d4d548d1c72a3eb07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0xde61878b0b21ce395266c44d4d548d1c72a3eb07",
    poolAddress: "0x8e1737aab1bb49dcdbfa014868c1cfb8702b7b66ce20e023e7d6f7427f9e1537",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xde61878b0b21ce395266c44d4d548d1c72a3eb07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 2 - $504.59K Liquidity - 1.2% Fee - Name: MiroShark. 1.4K Holders 24h Volume 757K USD Volitility 1.40
  // 0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3",
    poolAddress: "0x83a29b6619907f80e5a47d40f53d4af239a69980f22a08b10f43d357a9f06209",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xd7bc6a05a56655fb2052f742b012d1dfd66e1ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 3 - 201.20K Liquidity - 1.2% Fee - Name: EDGE. 700 Holders 24h Volume 277K USD Volitility 1.63
  // 0x62abe92f50c518165a5c010fe59f35023197fba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x62abe92f50c518165a5c010fe59f35023197fba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0x62abe92f50c518165a5c010fe59f35023197fba3",
    poolAddress: "0xd10a903640f598f257e6fb68742ad4126a3727b7f97adf9e83d17e907aaae704",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x62abe92f50c518165a5c010fe59f35023197fba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 4 - $615.23K Liquidity - 1.2% Fee - Name: Litcoin. 2.32K Holders 24h Volume 168.33K USD Volitility 0.4649
  // 0x316ffb9c875f900adcf04889e415cc86b564eba3 = ["0x316ffb9c875f900adcf04889e415cc86b564eba3","0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0x316ffb9c875f900adcf04889e415cc86b564eba3",
    poolAddress: "0xfd3e3e7fe5958221532ab8f56c0dd08379740797a7d03db8a4e975b524010a31",
    poolKey: {
      currency0: "0x316ffb9c875f900adcf04889e415cc86b564eba3",
      currency1: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 5 - $1.20M Liquidity - 1.02% Fee - Name: LienFi.  5.73K Holders 24h Volume 645.K USD Volitility 0.5079
  // 0x3722264ab15a1dfce5a5af89e6547f7949a8aba3 = ["0x3722264ab15a1dfce5a5af89e6547f7949a8aba3","0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
  {
    tokenAddress: "0x3722264ab15a1dfce5a5af89e6547f7949a8aba3",
    poolAddress: "0x6ef02666f150d9649655b884e043b61b0990fad9be4c632d0c7568bb24da9367",
    poolKey: {
      currency0: "0x3722264ab15a1dfce5a5af89e6547f7949a8aba3",
      currency1: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },
  // 6 $1.38M Liquidity - 1% Fee - Name: ClawBank.  3.52K Holders 24h Volume 615.87K USD Volitility 0.4344
  // 0x16332535e2c27da578bc2e82beb09ce9d3c8eb07 = ["0x16332535e2c27da578bc2e82beb09ce9d3c8eb07","0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x16332535e2c27da578bc2e82beb09ce9d3c8eb07",
    poolAddress: "0xb04b187062efbf94cf9b4b6f42bf688258d3c88b7c9283bbc74dbbfb1af40d54",
    poolKey: {
      currency0: "0x16332535e2c27da578bc2e82beb09ce9d3c8eb07",
      currency1: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 7 $3.31 M Liquidity - 1.2% Fee - Name: gitlawb. 4.82K Holders 24h Volume 2.07M USD Volitility 00.5650
  // 0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3",
    poolAddress: "0xec33256bf1ded407a57fd3c1965e7556e42ac14db09bc4e6fef57d5e2eb0b0b9",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x5f980dcfc4c0fa3911554cf5ab288ed0eb13dba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 8 $361.93K Liquidity - 1.2% Fee - Name: Helixa Cred. 13.9K Holders 24h Volume 60.19K USD Volitility 0.3005
  // 0xab3f23c2abcb4e12cc8b593c218a7ba64ed17ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xab3f23c2abcb4e12cc8b593c218a7ba64ed17ba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0xab3f23c2abcb4e12cc8b593c218a7ba64ed17ba3",
    poolAddress: "0x55a4f7a23c4c2616cf848e639a08bd4283d13e66f5fcf34f828b5ca7e4e96324",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xab3f23c2abcb4e12cc8b593c218a7ba64ed17ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 9 $998.82KLiquidity  - 1% Fee - Name: CLAWNCH. 1.35K Holders 24h Volume 109.61K USD Volitility 0.0602
  // 0xa1f72459dfa10bad200ac160ecd78c6b77a747be = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xa1f72459dfa10bad200ac160ecd78c6b77a747be",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0xa1f72459dfa10bad200ac160ecd78c6b77a747be",
    poolAddress: "0x03d3c21ea1daf51dd2898ebaf9342a93374877ba6ab34cc7ffe5b5d43ee46e0a",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xa1f72459dfa10bad200ac160ecd78c6b77a747be",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 10 $1.58M Liquidity - 1% Fee - Name: Moltbook. 27.53K Holders 24h Volume 57.52K USD Volitility 0.0356
  // 0xb695559b26bb2c9703ef1935c37aeae9526bab07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xb695559b26bb2c9703ef1935c37aeae9526bab07",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0xb695559b26bb2c9703ef1935c37aeae9526bab07",
    poolAddress: "0x15f351bf1637b43d70631ba95fb9bbb1ff21761c29b034c1b380aecb922464dd",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xb695559b26bb2c9703ef1935c37aeae9526bab07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 11 $592.65K Liquidity - 1.2% Fee - Name: nook. 2.63K Holders 24h Volume 121.49K USD Volitility 0.2048
  // 0xb233bdffd437e60fa451f62c6c09d3804d285ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xb233bdffd437e60fa451f62c6c09d3804d285ba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0xb233bdffd437e60fa451f62c6c09d3804d285ba3",
    poolAddress: "0xe93071444b085fe0b83b0e138c2f0e47d510c1f6fa604a83dd10c0c7f8a0bb97",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xb233bdffd437e60fa451f62c6c09d3804d285ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 12 - $465.51K Liquidity - .7% Fee -Name: Hermes OS 1.9K Holders 24h Volume 573.30K USD Volitility 1.19
  // 0x95ccfd2b81a9667b0cc979992632f98fc853eba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x95ccfd2b81a9667b0cc979992632f98fc853eba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
  {
    tokenAddress: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
    poolAddress: "0x336ad40640593281d9c519fa0994986817fce079a0c493ea08f7ed9cac55ff19",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },
  // 13 - $899.17K Liquidity - 1% Fee - Name: KellyClaude 6.93K Holders 24h Volume 91.74K USD Volitility 0.1021
  // 0x50d2280441372486beecdd328c1854743ebacb07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x50d2280441372486beecdd328c1854743ebacb07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x50d2280441372486beecdd328c1854743ebacb07",
    poolAddress: "0x7eac33d5641697366eaec3234147fd98ba25f01acca66a51a48bd129fc532145",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x50d2280441372486beecdd328c1854743ebacb07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 14 - $505.78K Liquidity - 1% Fee - Name: Juno. 3.22K Holders 24h Volume 262.10K USD - Volitility 0.51
  // 0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07",
    poolAddress: "0x1635213e2b19e459a4132df40011638b65ae7510a35d6a88c47ebf94912c7f2e",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x4e6c9f48f73e54ee5f3ab7e2992b2d733d0d0b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 16 - $242.84K Liquidity - 1..2% Fee - Name: Darksol. 871 Holders 24h Volume 229.66K USD Volitility 0.9457
  // 0x00cb1fbca324d51325a7264d54072bc073c28ba3 = ["0x00cb1fbca324d51325a7264d54072bc073c28ba3","0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0x00cb1fbca324d51325a7264d54072bc073c28ba3",
    poolAddress: "0xca9e6410406dd333b2761db109162c9943ea8a112048d5d4d87dd900f5b8369a",
    poolKey: {
      currency0: "0x00cb1fbca324d51325a7264d54072bc073c28ba3",
      currency1: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 18 - $280.93K Liquidity - 1% Fee - Name: Doppel. 3.91K  Holders 24h Volume 273.87K USD Volitility 0.9748
  // 0xf27b8ef47842e6445e37804896f1bc5e29381b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xf27b8ef47842e6445e37804896f1bc5e29381b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0xf27b8ef47842e6445e37804896f1bc5e29381b07",
    poolAddress: "0x87e22831f5b0b48759b9113128d1472a97e366ae777da0de2c990cb82d739b54",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xf27b8ef47842e6445e37804896f1bc5e29381b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 19 - $411.27K Liquidity - 1% Fee -  Name: FELIX. 6.63K Holders 24h Volume 27.05K USD Volitility 0.0657
  // 0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07",
    poolAddress: "0x6e19027912db90892200a2b08c514921917bc55d7291ec878aa382c193b50084",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xf30bf00edd0c22db54c9274b90d2a4c21fc09b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 20 - $218.94K Liquidity - 1% Fee - Name: BitVault. Signal 810 Holders 24h Volume 9.96K  USD Volitility 0.0454
  // 0xd88fd4a11255e51f64f78b4a7d74456325c2d8dc = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xd88fd4a11255e51f64f78b4a7d74456325c2d8dc",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0xd88fd4a11255e51f64f78b4a7d74456325c2d8dc",
    poolAddress: "0x8de32c3e440d497cd3b607555be1f6115717965fff56247c02976814edcf384f",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xd88fd4a11255e51f64f78b4a7d74456325c2d8dc",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  }, 
  // 21  - $1.25M Liquidity - 1% Fee - Name: clawd. - 15.42K Holders 24h Volume 49.75K USD Volitility 0.0394
  // 0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07",
    poolAddress: "0x9fd58e73d8047cb14ac540acd141d3fc1a41fb6252d674b730faf62fe24aa8ce",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x9f86db9fc6f7c9408e8fda3ff8ce4e78ac7a6b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 22 - $396.76K Liquidity - 1% Fee - Name: Molten. - Added 3.78K Holders 24h Volume 17.96K USD Volitility 0.0452
  // 0x59c0d5c34c301ac0600147924d6c9be22a2f0b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x59c0d5c34c301ac0600147924d6c9be22a2f0b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x59c0d5c34c301ac0600147924d6c9be22a2f0b07",
    poolAddress: "0x5d58fdc2eea2e365c8c476a15a61635804796fd891d9b348bbe514c0417ea070",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x59c0d5c34c301ac0600147924d6c9be22a2f0b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  // 23 $708.11K Liquidity - 1.2% Fee - Name: BOTCOIN. - Added 4.6K Holders 24h Volume 285.85K USD Volitility 0.3973
  // 0xa601877977340862ca67f816eb079958e5bd0ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xa601877977340862ca67f816eb079958e5bd0ba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
  {
    tokenAddress: "0xa601877977340862ca67f816eb079958e5bd0ba3",
    poolAddress: "0x5154ba0d6cfb5fe27644bc856064991e1c7672b7eb533d5d457db4c7144c2af5",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xa601877977340862ca67f816eb079958e5bd0ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  // 24 - $238.10K Liquidity - 1% Fee - Name: Regent. 2.33K Holders 24h Volume 960.45 USD Volitility 0.0040
  // 0x6f89bca4ea5931edfcb09786267b251dee752b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x6f89bca4ea5931edfcb09786267b251dee752b07",8388608,200,"0xd60d6b218116cfd801e28f78d011a203d2b068cc"]
  {
    tokenAddress: "0x6f89bca4ea5931edfcb09786267b251dee752b07",
    poolAddress: "0x4ed3b69ac263ad86482f609b2c2105f64bcfd3a7e02e8e078ec9fec1f0324bed",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x6f89bca4ea5931edfcb09786267b251dee752b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xd60d6b218116cfd801e28f78d011a203d2b068cc",
    },
  }, 
  // 25 - $233.51K Liquidity - 1% Fee - Name: SelfClaw. 186.92K Holders 24h Volume 57.52K USD Volitility 0.8005
  // 0x9ae5f51d81ff510bf961218f833f79d57bfbab07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x9ae5f51d81ff510bf961218f833f79d57bfbab07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x9ae5f51d81ff510bf961218f833f79d57bfbab07",
    poolAddress: "0xac16d463fe6783fe82ec1b95db01d25daf7c2f9f523baa8d2c0ec7e707d4d568",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x9ae5f51d81ff510bf961218f833f79d57bfbab07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },
  
   // 25 -  $337.36K Liquidity - 1% Fee - Name:Cody. 186.92K Holders 24h Volume $1.47K USD Volitility 0.004
   //   // 0x3977fc913db86b01a257232c568317798b903b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x3977fc913db86b01a257232c568317798b903b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
  {
    tokenAddress: "0x3977fc913db86b01a257232c568317798b903b07",
    poolAddress: "0xd93f984c201e72c04035d8ca02f54d9dfef23689471d6593fef1697a6a24a0a9",
    poolKey: {
      currency0: "0x3977fc913db86b01a257232c568317798b903b07",
      currency1: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0x34a45c6b61876d739400bd71228cbcbd4f53e8cc",
    },
  },
     // 26 - $388.09K Liquidity - 2% Fee - Name: Gitbank.  2.83K Holders 24h Volume 400K USD Volitility 1.03
   //   // 0xc21dd0ee043930711c2a3e55f39c7d3144d09b07 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xc21dd0ee043930711c2a3e55f39c7d3144d09b07",8388608,200,"0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc"]
   {
    tokenAddress: "0xc21dd0ee043930711c2a3e55f39c7d3144d09b07",
    poolAddress: "0xed3057cdc362b0724f454a00b8eb4f52e7b3ce98c562b4df51ff0adeb01d217a",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xc21dd0ee043930711c2a3e55f39c7d3144d09b07",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xb429d62f8f3bffb98cdb9569533ea23bf0ba28cc",
    },
  },

    // 27 - $842K Liquidity - 2% Fee - Name: Supergemma4.- 842K 2000 Holders 24h Volume $1.55M USD Volitility 1.84
   //   // 0x572c4fa77623652411574c51b5ddb7e1b750aba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x572c4fa77623652411574c51b5ddb7e1b750aba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
   {
    tokenAddress: "0x572c4fa77623652411574c51b5ddb7e1b750aba3",
    poolAddress: "0x7016371c9642e346094b51b9603e429828d3f8063537770020115af81b019145",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x572c4fa77623652411574c51b5ddb7e1b750aba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },

  // 28 - $439K Liquidity - .7% Fee - Name: grantr.-  1.43 Holders 24h Volume $362K USD Volitility .8235
   //   // 0x753f2af0f46361c9ae6fc347797f99b0c9e82ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x753f2af0f46361c9ae6fc347797f99b0c9e82ba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
   {
    tokenAddress: "0x753f2af0f46361c9ae6fc347797f99b0c9e82ba3",
    poolAddress: "0x9196ada2ee67f89f347a59c2615057e3dcea28a7697020fd86f37e63f5c2d67a",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x753f2af0f46361c9ae6fc347797f99b0c9e82ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },
    // 28 - $292.96K Liquidity - .7% Fee - Name: wake.-  866 Holders 24h Volume $188.65K USD Volitility 0.6420
   //   // 0x50c2cc97c4f487aa0cd742ab4b6afe8b8511bba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x50c2cc97c4f487aa0cd742ab4b6afe8b8511bba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
   {
    tokenAddress: "0x50c2cc97c4f487aa0cd742ab4b6afe8b8511bba3",
    poolAddress: "0x9196ada2ee67f89f347a59c2615057e3dcea28a7697020fd86f37e63f5c2d67a",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x50c2cc97c4f487aa0cd742ab4b6afe8b8511bba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },
  // 29 aeon  - 
     // 0xbf8e8f0e8866a7052f948c16508644347c57aba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xbf8e8f0e8866a7052f948c16508644347c57aba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
   {
    tokenAddress: "0xbf8e8f0e8866a7052f948c16508644347c57aba3",
    poolAddress: "0x4a9b9e13975d26f4e3e17c655593bb82145dd4452aedafb826d856b817c9cfd4",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0xbf8e8f0e8866a7052f948c16508644347c57aba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
    },
  },
  
  // 30 Berry - 
  //   // 0x778d347b2ffbadf31a2a1be9cf42b4c7ba8b1ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x778d347b2ffbadf31a2a1be9cf42b4c7ba8b1ba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
  {
    tokenAddress: "0x778d347b2ffbadf31a2a1be9cf42b4c7ba8b1ba3",
    poolAddress: "0xabacf9efd8f34eb11ea12be37dfccd32395f825ffeb4aa10a9177a0d9fed6327",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x778d347b2ffbadf31a2a1be9cf42b4c7ba8b1ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },

  // 31 Blocktronics — 
  //   // 0x7afe438411ee3959c7de6f7fb76bf9c769320ba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x7afe438411ee3959c7de6f7fb76bf9c769320ba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
  {
    tokenAddress: "0x7afe438411ee3959c7de6f7fb76bf9c769320ba3",
    poolAddress: "0x7f36b7889aaf2268e8a39865f02451c102bf9070d94569034fc011d6349d9dd8",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x7afe438411ee3959c7de6f7fb76bf9c769320ba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },

  // 32 Orlix AI — 
  //   // 0x799c28bac95b3e0b26534d1e9a586511895ecba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x799c28bac95b3e0b26534d1e9a586511895ecba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
  {
    tokenAddress: "0x799c28bac95b3e0b26534d1e9a586511895ecba3",
    poolAddress: "0xf11c9dc85be5fda498a34525bfa9d13177934149068c57bb17133f0156fabe16",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x799c28bac95b3e0b26534d1e9a586511895ecba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },

  // 33 1claw AI — 
  //   // 0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3",8388608,200,"0xbdf938149ac6a781f94faa0ed45e6a0e984c6544"]
  {
    tokenAddress: "0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3",
    poolAddress: "0xf80335f8d6ba2a5970474a236bec053a65de6ca6fa1cd1f80086d843fef112bb",
    poolKey: {
      currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
      currency1: "0x61d91cff0fc9fbbdb89f505cf8a7422bf95fdba3",
      fee: 8388608,
      tickSpacing: 200,
      hooks: "0xbdf938149ac6a781f94faa0ed45e6a0e984c6544",
    },
  },

  // 34 evo- — 
//   // 0x721b072dbb616f29eea73ac004e03fd4e884bba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0x721b072dbb616f29eea73ac004e03fd4e884bba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
{
  tokenAddress: "0x721b072dbb616f29eea73ac004e03fd4e884bba3",
  poolAddress: "0xd8ee119a65d3a902ced4ef7693b98e62a7fbb1d7808a693dbb6961d7f544fb80",
  poolKey: {
    currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    currency1: "0x721b072dbb616f29eea73ac004e03fd4e884bba3",
    fee: 8388608,
    tickSpacing: 200,
    hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
  },
},


  // 34 Surplus- — 
  // 0xc52aedec3374422d7510e294cfaa90799595cba3 = ["0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73","0xc52aedec3374422d7510e294cfaa90799595cba3",8388608,200,"0xbb7784a4d481184283ed89619a3e3ed143e1adc0"]
{
  tokenAddress: "0xc52aedec3374422d7510e294cfaa90799595cba3",
  poolAddress: "0xfc25fdd217e288d03a877f0b7d49e0bbe52b2288c88de929125062569fc7eb2a",
  poolKey: {
    currency0: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    currency1: "0xc52aedec3374422d7510e294cfaa90799595cba3",
    fee: 8388608,
    tickSpacing: 200,
    hooks: "0xbb7784a4d481184283ed89619a3e3ed143e1adc0",
  },
},

];

const normalizeHexAddress = (addr: string): string => addr.trim().toLowerCase();

const TOKEN_POOL_PAIRS_NORMALIZED = TOKEN_POOL_PAIRS.map((p) => ({
  tokenAddress: normalizeHexAddress(p.tokenAddress),
  poolAddress: normalizeHexAddress(p.poolAddress),
}));

const TOKEN_POOL_PAIRS_V4_NORMALIZED = TOKEN_POOL_PAIRS_V4.map((p) => ({
  tokenAddress: normalizeHexAddress(p.tokenAddress),
  poolAddress: normalizeHexAddress(p.poolAddress),
  poolKey: p.poolKey,
}));

/** V4 token addresses for Triton / LiquidStratMin (excludes WETH). */
export const TRITON_V4_TOKEN_ADDRESS_ARRAY = TOKEN_POOL_PAIRS_V4_NORMALIZED.map((p) => p.tokenAddress);

export const POOL_ADDRESS_BY_TOKEN_V4 = new Map(
  TOKEN_POOL_PAIRS_V4_NORMALIZED.map((p) => [p.tokenAddress, p.poolAddress])
);

/** CoinGecko pool id map for FloatStrategy (V3) vs FloatStrategyV4 token universes. */
export function getPoolByTokenMapForStrategyRegistry(
  strategyRegistryKey: "FloatStrategy" | "FloatStrategyV4" = "FloatStrategy"
): Map<string, string> {
  return strategyRegistryKey === "FloatStrategyV4"
    ? POOL_ADDRESS_BY_TOKEN_V4
    : POOL_ADDRESS_BY_TOKEN_ADDRESS;
}

export const TOKEN_POOL_PAIRS_V4_EXPORT = TOKEN_POOL_PAIRS_V4_NORMALIZED;

// Ensure no duplicates in token array (order and mapping correctness).
const duplicateTokenAddresses = (() => {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const p of TOKEN_POOL_PAIRS_NORMALIZED) {
    if (seen.has(p.tokenAddress)) dupes.add(p.tokenAddress);
    seen.add(p.tokenAddress);
  }
  return [...dupes];
})();

if (duplicateTokenAddresses.length > 0) {
  throw new Error(
    `TOKEN_POOL_PAIRS has duplicate token addresses: ${duplicateTokenAddresses.join(", ")}`
  );
}

// Tokens Demeter can choose for changeStrategyAsset. Exclude WETH (Robinhood WETH) – contract's WETH path fails gas estimation.
const TOKEN_ADDRESS_ARRAY = TOKEN_POOL_PAIRS_NORMALIZED.map((p) => p.tokenAddress);
const POOL_ADDRESS_BY_TOKEN_ADDRESS = new Map(
  TOKEN_POOL_PAIRS_NORMALIZED.map((p) => [p.tokenAddress, p.poolAddress]) 
);

const NETWORK = COINGECKO_NETWORK;

/** Max chars for a tool response sent to the LLM to avoid context length errors (128k token limit). */
const MAX_TOOL_RESPONSE_CHARS = 28_000;

function truncateToolResponse(json: string): string {
  if (json.length <= MAX_TOOL_RESPONSE_CHARS) return json;
  const truncated = json.slice(0, MAX_TOOL_RESPONSE_CHARS - 80);
  return truncated + `"...[truncated ${json.length - truncated.length} chars for context limit]"`;
}

type TokenSummaryRow = {
  symbol: string;
  name: string;
  address: string;
  price_usd: number;
  market_cap_usd: number;
  volume_h24: number;
  volume_h6: number;
  volume_h1: number;
  volume_m5: number;
  volume_m15: number;
  volume_m30: number;
  volume_h12: number;
  pool_name: string | null;
  price_change_h24_pct: number | null;
  price_change_h6_pct: number | null;
  price_change_h1_pct: number | null;
  price_change_m5_pct: number | null;
  price_change_m15_pct: number | null;
  price_change_m30_pct: number | null;
  price_change_h12_pct: number | null;
  /** Pool % change; `null` when API omits (ranking treats missing as worst, never as 0%). */
  price_change_h6: number | null;
  price_change_h1: number | null;
  price_change_h12: number | null;
  price_stability_h24: number;
  buy_sell_ratio_h24: number | null;
  buy_sell_ratio_h6: number | null;
  liquidity_usd: number | null;
  /** Pool `volume_usd.h24` (USD) from CoinGecko on the ranked pool. */
  pool_volume_h24_usd: number;
  /** Pool `reserve_in_usd` when present and positive; else null (volatility denominator falls back to base+quote). */
  pool_reserve_in_usd: number | null;
  /** Pool 24h volume ÷ USD liquidity (`reserve_in_usd` if positive, else base+quote liquidity sum). */
  volatility_h24: number;
  /** Pool 6h volume ÷ USD liquidity (`reserve_in_usd` if positive, else base+quote liquidity sum). */
  volatility_h6: number;
};

/** Synthetic row so stable rotation passes volume/liquidity floors (V3: USDC; V4: WETH). */
function buildStableBreadthSyntheticTokenSummaryRow(
  stableMode: MarketBreadthStableMode = "v3_usdc"
): TokenSummaryRow {
  const th = getRankingEligibilityThresholds(stableMode === "v4_weth" ? "float_v4" : "float_v3");
  const minV = th.minVolumeH12Usd;
  const minL = th.minPoolLiquidityUsd;
  const vol12 = Math.max(minV * 100, minV + 1);
  const liq = Math.max(minL * 100, minL + 1);
  const poolVol24 = vol12 * 100;
  const poolVolH6 = vol12 * 5;

  if (stableMode === "v4_weth") {
    const addr = STABLE_V4_WETH_ADDRESS;
    return {
      symbol: "WETH",
      name: "Wrapped Ether",
      address: addr,
      price_usd: 3000,
      market_cap_usd: 0,
      volume_h24: vol12 * 10,
      volume_h6: vol12 * 5,
      volume_h1: vol12 * 2,
      volume_m5: vol12,
      volume_m15: vol12,
      volume_m30: vol12,
      volume_h12: vol12,
      pool_name: "WETH (Float V4 market breadth stable)",
      price_change_h24_pct: 0,
      price_change_h6_pct: 0,
      price_change_h1_pct: 0,
      price_change_m5_pct: 0,
      price_change_m15_pct: 0,
      price_change_m30_pct: 0,
      price_change_h12_pct: 0,
      price_change_h6: 0,
      price_change_h1: 0,
      price_change_h12: 0,
      price_stability_h24: 1,
      buy_sell_ratio_h24: 0.5,
      buy_sell_ratio_h6: 0.5,
      liquidity_usd: liq,
      pool_volume_h24_usd: poolVol24,
      pool_reserve_in_usd: liq,
      volatility_h24: liq > 0 ? poolVol24 / liq : 0,
      volatility_h6: liq > 0 ? poolVolH6 / liq : 0,
    };
  }

  const addr = STABLE_USDC_WETH_PAIR.tokenAddress;
  return {
    symbol: "USDC",
    name: "USD Coin",
    address: addr,
    price_usd: 1,
    market_cap_usd: 0,
    volume_h24: vol12 * 10,
    volume_h6: vol12 * 5,
    volume_h1: vol12 * 2,
    volume_m5: vol12,
    volume_m15: vol12,
    volume_m30: vol12,
    volume_h12: vol12,
    pool_name: "WETH/USDC (Float V3 market breadth stable)",
    price_change_h24_pct: 0,
    price_change_h6_pct: 0,
    price_change_h1_pct: 0,
    price_change_m5_pct: 0,
    price_change_m15_pct: 0,
    price_change_m30_pct: 0,
    price_change_h12_pct: 0,
    price_change_h6: 0,
    price_change_h1: 0,
    price_change_h12: 0,
    price_stability_h24: 1,
    buy_sell_ratio_h24: 0.5,
    buy_sell_ratio_h6: 0.5,
    liquidity_usd: liq,
    pool_volume_h24_usd: poolVol24,
    pool_reserve_in_usd: liq,
    volatility_h24: liq > 0 ? poolVol24 / liq : 0,
    volatility_h6: liq > 0 ? poolVolH6 / liq : 0,
  };
}

const COINGECKO_API_BASE = "https://pro-api.coingecko.com/api/v3";

/** Max addresses per onchain tokens/multi + pools/multi request (CoinGecko plan + URL length). */
const COINGECKO_ONCHAIN_MULTI_BATCH_SIZE = (() => {
  const raw = process.env.COIN_GECKO_ONCHAIN_MULTI_BATCH_SIZE?.trim();
  const n = raw ? Number(raw) : 15;
  return Number.isFinite(n) && n >= 1 ? Math.min(50, Math.floor(n)) : 15;
})();

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Removed - using Record<string, Record<string, number>> directly

/**
 * Get price for a token by contract address
 */
async function getTokenPrice(
  contractAddress: string,
  network: string = COINGECKO_NETWORK,
  vsCurrency: string = "usd"
): Promise<number> {
  if (!coinGeckoApiKey()) {
    throw new Error('COIN_GECKO_API_KEY is required in environment variables');
  }
  
  const url = `${COINGECKO_API_BASE}/simple/token_price/${network}?contract_addresses=${contractAddress}&vs_currencies=${vsCurrency}`;
  const headers = coinGeckoHeaders();
  
  const response = await fetch(url, { headers });
  
  if (!response.ok) {
    throw new Error(formatCoinGeckoHttpError(response.status, response.statusText, "simple/token_price"));
  }
  
  const data: Record<string, Record<string, number>> = await response.json();
  const price = data[contractAddress.toLowerCase()]?.[vsCurrency.toLowerCase()];
  
  if (price === undefined) {
    throw new Error(`Price not found for contract ${contractAddress} on ${network} in ${vsCurrency}`);
  }
  
  return price;
}

/**
 * Get prices for multiple tokens by contract addresses
 */
async function getMultipleTokenPrices(
  contractAddresses: string[],
  network: string = COINGECKO_NETWORK,
  vsCurrency: string = "usd"
): Promise<Record<string, number>> {
  if (!coinGeckoApiKey()) {
    throw new Error('COIN_GECKO_API_KEY is required in environment variables');
  }
  
  const addresses = contractAddresses.join(",");
  const url = `${COINGECKO_API_BASE}/simple/token_price/${network}?contract_addresses=${addresses}&vs_currencies=${vsCurrency}`;
  const headers = coinGeckoHeaders();
  
  const response = await fetch(url, { headers });
  
  if (!response.ok) {
    throw new Error(formatCoinGeckoHttpError(response.status, response.statusText, "simple/token_price"));
  }
  
  const data: Record<string, Record<string, number>> = await response.json();
  const prices: Record<string, number> = {};
  
  for (const address of contractAddresses) {
    const price = data[address.toLowerCase()]?.[vsCurrency.toLowerCase()];
    if (price !== undefined) {
      prices[address] = price;
    }
  }
  
  return prices;
}

/**
 * Extract only the key fields needed from getTokenData API response.
 * Token-level: name, volume_usd.h24, market_cap_usd
 * Pool-level (included): quote_token_liquidity_usd, base_token_liquidity_usd,
 *   price_change_percentage, transactions, volume_usd (h1, h6, h24)
 */
function extractTokenDataFields(raw: unknown): unknown {
  const obj = raw as {
    data?: Array<{ attributes?: Record<string, unknown> }>;
    included?: Array<{ attributes?: Record<string, unknown> }>;
  };
  const tokens = (obj.data ?? []).map((t) => {
    const a = t.attributes ?? {};
    return {
      address: a.address,
      name: a.name,
      symbol: a.symbol,
      price_usd: a.price_usd,
      market_cap_usd: a.market_cap_usd,
      volume_usd: a.volume_usd,
    };
  });
  const timePeriods = ["m5", "m15", "m30", "h1", "h6", "h24"] as const;
  const extractTx = (tx: Record<string, { buys?: number; sells?: number; buyers?: number; sellers?: number }> | undefined) => {
    if (!tx || typeof tx !== "object") return undefined;
    const out: Record<string, { buys: number; sells: number; buyers: number; sellers: number }> = {};
    for (const k of timePeriods) {
      const v = tx[k];
      if (v && typeof v === "object")
        out[k] = { buys: v.buys ?? 0, sells: v.sells ?? 0, buyers: v.buyers ?? 0, sellers: v.sellers ?? 0 };
    }
    return Object.keys(out).length ? out : undefined;
  };

  const pools = (obj.included ?? []).map((p) => {
    const a = p.attributes ?? {};
    const pcp = a.price_change_percentage as Record<string, string> | undefined;
    const tx = a.transactions as Record<string, { buys?: number; sells?: number; buyers?: number; sellers?: number }> | undefined;
    return {
      address: a.address,
      name: a.name,
      base_token_liquidity_usd: a.base_token_liquidity_usd,
      quote_token_liquidity_usd: a.quote_token_liquidity_usd,
      price_change_percentage: pcp
        ? { m5: pcp.m5, m15: pcp.m15, m30: pcp.m30, h1: pcp.h1, h6: pcp.h6, h24: pcp.h24 }
        : undefined,
      transactions: extractTx(tx),
      volume_usd: a.volume_usd,
    };
  });
  return { tokens, pools };
}

/**
 * Get rich token data (name, symbol, price, fdv, market cap, volume, pools) for one or more tokens
 */
async function getTokenData(
  contractAddresses: string[],
  network: string = COINGECKO_NETWORK,
  poolByToken: Map<string, string> = POOL_ADDRESS_BY_TOKEN_ADDRESS
): Promise<{ tokens: unknown[]; pools: unknown[] }> {
  if (!coinGeckoApiKey()) {
    throw new Error('COIN_GECKO_API_KEY is required in environment variables');
  }

  const requestedTokensLc = [...new Set(contractAddresses.map(normalizeHexAddress))];

  const missingTokens = requestedTokensLc.filter((t) => !poolByToken.has(t));
  if (missingTokens.length > 0) {
    throw new Error(
      `Missing hard-coded pool mappings for token addresses: ${missingTokens.join(", ")}`
    );
  }

  // Order matters because `buildTokenComparison()` aligns tokens/pools by index.
  const orderedPairs = requestedTokensLc.map((tokenAddress) => ({
    tokenAddress,
    poolAddress: poolByToken.get(tokenAddress)!,
  }));

  const headers = coinGeckoHeaders();

  const extractTx = (tx: unknown): unknown => {
    if (!tx || typeof tx !== "object") return undefined;
    const timePeriods = ["m5", "m15", "m30", "h1", "h6", "h24"] as const;
    const out: Record<
      string,
      { buys: number; sells: number; buyers: number; sellers: number }
    > = {};
    for (const k of timePeriods) {
      const v = (tx as Record<string, unknown>)[k];
      if (v && typeof v === "object") {
        const vv = v as Record<string, unknown>;
        out[k] = {
          buys: typeof vv.buys === "number" ? vv.buys : 0,
          sells: typeof vv.sells === "number" ? vv.sells : 0,
          buyers: typeof vv.buyers === "number" ? vv.buyers : 0,
          sellers: typeof vv.sellers === "number" ? vv.sellers : 0,
        };
      }
    }
    return Object.keys(out).length ? out : undefined;
  };

  const tokenByAddressLc = new Map<
    string,
    { address: string; name: string; symbol: string; price_usd: string; market_cap_usd: string; volume_usd: unknown }
  >();
  const poolByAddressLc = new Map<
    string,
    {
      address: string;
      name: string | null;
      base_token_liquidity_usd?: string;
      quote_token_liquidity_usd?: string;
      reserve_in_usd?: string;
      price_change_percentage?: unknown;
      transactions?: unknown;
      volume_usd?: unknown;
    }
  >();

  const pairChunks = chunkArray(orderedPairs, COINGECKO_ONCHAIN_MULTI_BATCH_SIZE);
  if (pairChunks.length > 1) {
    console.log(
      `[CoinGecko] onchain multi fetch: ${orderedPairs.length} tokens in ${pairChunks.length} batch(es) (size ≤${COINGECKO_ONCHAIN_MULTI_BATCH_SIZE})`
    );
  }

  const tokenQuery = new URLSearchParams({
    include: "top_pools",
    include_composition: "true",
  });
  const poolQuery = new URLSearchParams({
    include: "base_token,quote_token,dex",
    include_composition: "true",
    include_volume_breakdown: "true",
  });

  for (const pairChunk of pairChunks) {
    const tokenAddressesCsv = pairChunk.map((p) => p.tokenAddress).join(",");
    const tokenUrl = `${COINGECKO_API_BASE}/onchain/networks/${network}/tokens/multi/${encodeURIComponent(tokenAddressesCsv)}?${tokenQuery.toString()}`;

    const poolAddressesUnique = Array.from(new Set(pairChunk.map((p) => p.poolAddress)));
    const poolAddressesCsv = poolAddressesUnique.join(",");
    const poolUrl = `${COINGECKO_API_BASE}/onchain/networks/${network}/pools/multi/${encodeURIComponent(poolAddressesCsv)}?${poolQuery.toString()}`;

    const tokenResponse = await fetch(tokenUrl, { headers });
    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => "");
      throw new Error(
        formatCoinGeckoHttpError(tokenResponse.status, tokenResponse.statusText, "tokens/multi", body)
      );
    }

    const poolResponse = await fetch(poolUrl, { headers });
    if (!poolResponse.ok) {
      const body = await poolResponse.text().catch(() => "");
      throw new Error(
        formatCoinGeckoHttpError(poolResponse.status, poolResponse.statusText, "pools/multi", body)
      );
    }

    const tokenRaw = await tokenResponse.json();
    const poolRaw = await poolResponse.json();

    for (const t of tokenRaw?.data ?? []) {
      const a = t?.attributes ?? {};
      if (typeof a?.address === "string") {
        const addressLc = normalizeHexAddress(a.address);
        tokenByAddressLc.set(addressLc, {
          address: a.address,
          name: a.name,
          symbol: a.symbol,
          price_usd: a.price_usd,
          market_cap_usd: a.market_cap_usd,
          volume_usd: a.volume_usd,
        });
      }
    }

    for (const p of poolRaw?.data ?? []) {
      const a = p?.attributes ?? {};
      if (typeof a?.address === "string") {
        const addressLc = normalizeHexAddress(a.address);
        poolByAddressLc.set(addressLc, {
          address: a.address,
          name: typeof a.name === "string" ? a.name : typeof a.pool_name === "string" ? a.pool_name : null,
          base_token_liquidity_usd: a.base_token_liquidity_usd,
          quote_token_liquidity_usd: a.quote_token_liquidity_usd,
          reserve_in_usd: a.reserve_in_usd as string | undefined,
          price_change_percentage: a.price_change_percentage,
          transactions: extractTx(a.transactions),
          volume_usd: a.volume_usd,
        });
      }
    }
  }

  const tokensOrdered = orderedPairs.map((p) => {
    const token = tokenByAddressLc.get(p.tokenAddress);
    if (!token) throw new Error(`Token data missing for ${p.tokenAddress}`);
    return token;
  });

  const poolsOrdered = orderedPairs.map((p) => {
    const pool = poolByAddressLc.get(p.poolAddress);
    if (!pool) throw new Error(`Pool data missing for pool ${p.poolAddress}`);
    return pool;
  });

  return { tokens: tokensOrdered, pools: poolsOrdered };
}

/**
 * Build a comparison structure from token data for side-by-side analysis.
 */
function buildTokenComparison(
  data: { tokens: unknown[]; pools: unknown[] },
  rankingMetrics: TokenRankingMetricsMap = getTokenRankingMetrics(),
  options?: {
    changeStrategyStrictShortHorizons?: boolean;
    offensiveMomentumAbsoluteGates?: boolean;
    /** When set, market-breadth stable rotation can require this token’s pool 24h Δ% &lt; 0 (see {@link getMarketBreadthNegativeH24FractionGte}). */
    currentStrategyTokenAddress?: string | null;
    /** When true, apply market-breadth stable path regardless of the current-asset negative-24h guard. */
    forceMarketBreadthStable?: boolean;
    /** When true, never force stable rotation from cohort 24h breadth (Triton offensive-only). */
    disableMarketBreadth?: boolean;
    /** V3: USDC + changeStrategyAsset; V4: WETH + exitStrategyToStable (default v3_usdc). */
    marketBreadthStableMode?: MarketBreadthStableMode;
    /** Float V3 vs Float V4 / Triton threshold bundle (default float_v3). */
    rankingProfile?: FloatRankingProfile;
    /** Pre-resolved thresholds; overrides rankingProfile when set. */
    rankingThresholds?: RankingEligibilityThresholds;
    /** μ per metric for baseline-centered weighted score (optional). */
    weightedScoreBaseline?: Record<string, number>;
    /** Fixed per-metric {lo, hi} for absolute OFFENSIVE weighted score (used on the momentum-gated offensive path). */
    weightedScoreBounds?: Record<string, { lo: number; hi: number }>;
  }
): unknown {
  const tokens = data.tokens as Array<{
    address: string;
    name: string;
    symbol: string;
    price_usd: string;
    market_cap_usd: string;
    volume_usd?: { h24?: string };
  }>;
  const pools = data.pools as Array<{
    address: string;
    name: string;
    base_token_liquidity_usd?: string;
    quote_token_liquidity_usd?: string;
    reserve_in_usd?: string;
    price_change_percentage?: { m5?: string; m15?: string; m30?: string; h1?: string; h6?: string; h24?: string };
    transactions?: Record<string, { buys: number; sells: number; buyers: number; sellers: number }>;
    volume_usd?: { m5?: string; m15?: string; m30?: string; h1?: string; h6?: string; h24?: string };
  }>;

  const parseNum = (v: unknown): number => (typeof v === "string" ? parseFloat(v) : Number(v) || 0);

  /**
   * Pool Δ% from CoinGecko `attributes.price_change_percentage.*` (usually strings).
   * CoinGecko may return `'0'` for m5/m15 even when that window’s `volume_usd` is positive (flat / rounded pool TWAP);
   * their pools/multi OpenAPI example shows `m5: '0'` with non‑zero m5 volume on WETH/USDC.
   */
  const parseOptionalPoolPriceChangePct = (v: unknown): number | null => {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string") {
      const s = v.trim();
      if (s === "") return null;
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  /** Pool `volume_usd.*` is usually a string; occasionally nested. Missing → 0 (caller may treat 0 as “no short-window data”). */
  const parsePoolVolumeUsd = (v: unknown): number => {
    if (v == null) return 0;
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    if (typeof v === "string") {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    }
    if (typeof v === "object" && v !== null && "usd" in (v as Record<string, unknown>)) {
      return parsePoolVolumeUsd((v as Record<string, unknown>).usd);
    }
    return 0;
  };

  const tokensSummary = tokens.map((t, i) => {
    const pool = pools[i];
    const volH24 = t.volume_usd?.h24;
    const volH6 = pool?.volume_usd?.h6;
    const poolVol = pool?.volume_usd as Record<string, unknown> | undefined;
    const poolVolH12 = poolVol?.["h12"] ?? (poolVol?.h6 != null && poolVol?.h24 != null
      ? (parseNum(poolVol.h6) + parseNum(poolVol.h24)) / 2
      : poolVol?.h24);
    const priceChgH24 = pool?.price_change_percentage?.h24;
    const priceChgH6 = pool?.price_change_percentage?.h6;
    const priceChgH1 = pool?.price_change_percentage?.h1;
    const priceChgM5 = pool?.price_change_percentage?.m5;
    const priceChgM15 = pool?.price_change_percentage?.m15;
    const priceChgM30 = pool?.price_change_percentage?.m30;
    const priceChgPool = pool?.price_change_percentage as Record<string, unknown> | undefined;
    const priceChgH12 = priceChgPool?.["h12"] ?? (priceChgH6 != null && priceChgH24 != null ? (parseNum(priceChgH6) + parseNum(priceChgH24)) / 2 : priceChgH24 ?? priceChgH6);
    const txH24 = pool?.transactions?.h24;
    const txH6 = pool?.transactions?.h6;
    const buySellRatioH24 = txH24 ? (txH24.buys + txH24.sells > 0 ? txH24.buys / (txH24.buys + txH24.sells) : 0.5) : null;
    const buySellRatioH6 = txH6 ? (txH6.buys + txH6.sells > 0 ? txH6.buys / (txH6.buys + txH6.sells) : 0.5) : null;
    const baseQuoteLiq = pool ? parseNum(pool.base_token_liquidity_usd) + parseNum(pool.quote_token_liquidity_usd) : 0;
    const reserveParsed = pool ? parseNum(pool.reserve_in_usd) : 0;
    const liqForVolatility = reserveParsed > 0 ? reserveParsed : baseQuoteLiq;
    const poolVolH24Usd = parsePoolVolumeUsd(poolVol?.["h24"]);
    const poolVolH6Usd = parsePoolVolumeUsd(poolVol?.["h6"]);
    const volatilityH24 = liqForVolatility > 0 ? poolVolH24Usd / liqForVolatility : 0;
    const volatilityH6 = liqForVolatility > 0 ? poolVolH6Usd / liqForVolatility : 0;
    return {
      symbol: t.symbol,
      name: t.name,
      address: t.address,
      price_usd: parseNum(t.price_usd),
      market_cap_usd: parseNum(t.market_cap_usd),
      volume_h24: parseNum(volH24),
      volume_h6: parseNum(volH6),
      volume_h1: parsePoolVolumeUsd(poolVol?.["h1"]),
      volume_m5: parsePoolVolumeUsd(poolVol?.["m5"]),
      volume_m15: parsePoolVolumeUsd(poolVol?.["m15"]),
      volume_m30: parsePoolVolumeUsd(poolVol?.["m30"]),
      volume_h12: parseNum(poolVolH12),
      pool_name: pool?.name ?? null,
      price_change_h24_pct: parseOptionalPoolPriceChangePct(priceChgH24),
      price_change_h6_pct: parseOptionalPoolPriceChangePct(priceChgH6),
      price_change_h1_pct: parseOptionalPoolPriceChangePct(priceChgH1),
      price_change_m5_pct: parseOptionalPoolPriceChangePct(priceChgM5),
      price_change_m15_pct: parseOptionalPoolPriceChangePct(priceChgM15),
      price_change_m30_pct: parseOptionalPoolPriceChangePct(priceChgM30),
      price_change_h12_pct: parseOptionalPoolPriceChangePct(priceChgH12),
      price_change_h6: parseOptionalPoolPriceChangePct(priceChgH6),
      price_change_h1: parseOptionalPoolPriceChangePct(priceChgH1),
      price_change_h12: parseOptionalPoolPriceChangePct(priceChgH12),
      price_stability_h24: (() => {
        const p = parseOptionalPoolPriceChangePct(priceChgH24);
        return p != null ? 1 / (1 + Math.abs(p)) : 1;
      })(),
      buy_sell_ratio_h24: buySellRatioH24,
      buy_sell_ratio_h6: buySellRatioH6,
      liquidity_usd: pool ? baseQuoteLiq : null,
      pool_volume_h24_usd: poolVolH24Usd,
      pool_reserve_in_usd: reserveParsed > 0 ? reserveParsed : null,
      volatility_h24: volatilityH24,
      volatility_h6: volatilityH6,
    };
  });

  const byMarketCap = [...tokensSummary].sort((a, b) => b.market_cap_usd - a.market_cap_usd);
  const byVolume = [...tokensSummary].sort((a, b) => b.volume_h12 - a.volume_h12);
  const byPriceChange = [...tokensSummary].filter((t) => t.price_change_h24_pct != null).sort((a, b) => (b.price_change_h24_pct ?? 0) - (a.price_change_h24_pct ?? 0));

  const ratios: Record<string, unknown> = {};
  if (tokensSummary.length >= 2) {
    const topMc = byMarketCap[0];
    const topVol = byVolume[0];
    const bottomMc = byMarketCap[byMarketCap.length - 1];
    const bottomVol = byVolume[byVolume.length - 1];
    if (bottomMc.market_cap_usd > 0)
      ratios.market_cap_ratio_highest_to_lowest = (topMc.market_cap_usd / bottomMc.market_cap_usd).toFixed(2);
    if (bottomVol.volume_h12 > 0)
      ratios.volume_h12_ratio_highest_to_lowest = (topVol.volume_h12 / bottomVol.volume_h12).toFixed(2);
  }

  const rankingProfile = options?.rankingProfile ?? "float_v3";
  const thresholdBundle =
    options?.rankingThresholds ?? getRankingEligibilityThresholds(rankingProfile);
  const minVolumeH12Usd = thresholdBundle.minVolumeH12Usd;
  const minPoolLiquidityUsd = thresholdBundle.minPoolLiquidityUsd;
  const minVolatilityH24Usd = thresholdBundle.minVolatilityH24Usd;
  const maxVolatilityH24Usd = thresholdBundle.maxVolatilityH24Usd;
  const maxNegativePriceChangeH24Pct = thresholdBundle.maxNegativePriceChangeH24Pct;
  const maxNegativePriceChangeM5M15M30Pct = thresholdBundle.maxNegativePriceChangeM5M15M30Pct;
  const changeStrategyStrictShortHorizons = options?.changeStrategyStrictShortHorizons === true;
  const offensiveMomentumAbsoluteGates = options?.offensiveMomentumAbsoluteGates === true;

  const marketH24Breadth = computeMarketH24BreadthFromTokenSummary(tokensSummary, {
    fractionGte: thresholdBundle.marketBreadthNegativeH24FractionGte,
  });
  const breadthParams = {
    fractionGte: thresholdBundle.marketBreadthNegativeH24FractionGte,
    requireCurrentAssetNegativeH24: thresholdBundle.marketBreadthRequireCurrentAssetNegativeH24,
  };
  let applyMarketBreadthStable =
    options?.disableMarketBreadth !== true && marketH24Breadth.defensive;
  let marketBreadthStableSkippedReason: string | null = null;
  if (
    applyMarketBreadthStable &&
    breadthParams.requireCurrentAssetNegativeH24 &&
    options?.forceMarketBreadthStable !== true
  ) {
    const cur = options?.currentStrategyTokenAddress?.trim();
    if (!cur) {
      applyMarketBreadthStable = false;
      marketBreadthStableSkippedReason = "current_strategy_address_missing";
    } else {
      const curLc = normalizeHexAddress(cur);
      const curRow = tokensSummary.find((t) => normalizeHexAddress(t.address) === curLc);
      const h24 = curRow?.price_change_h24_pct;
      const currentNegative24h =
        typeof h24 === "number" && Number.isFinite(h24) && h24 < 0;
      if (!currentNegative24h) {
        applyMarketBreadthStable = false;
        marketBreadthStableSkippedReason =
          curRow == null
            ? "current_asset_not_in_snapshot"
            : h24 == null || !Number.isFinite(h24 as number)
              ? "current_asset_h24_missing"
              : "current_asset_not_negative_24h";
      }
    }
  }

  if (applyMarketBreadthStable) {
    const stableMode = options?.marketBreadthStableMode ?? "v3_usdc";
    const stableRow = buildStableBreadthSyntheticTokenSummaryRow(stableMode);
    const onChainAction =
      stableMode === "v4_weth" ? "exitStrategyToStable" : "changeStrategyAsset";
    const stableLc = stableRow.address.toLowerCase();
    const tokensSummaryMerged = tokensSummary.some((t) => t.address.toLowerCase() === stableLc)
      ? tokensSummary
      : [...tokensSummary, stableRow];
    const metricKeys = Object.keys(rankingMetrics) as string[];
    return {
      tokens_summary: tokensSummaryMerged,
      min_volume_h12_usd: minVolumeH12Usd,
      min_pool_liquidity_usd: minPoolLiquidityUsd,
      min_volatility_h24_usd: minVolatilityH24Usd,
      max_volatility_h24_usd: maxVolatilityH24Usd,
      max_negative_price_change_h24_pct: maxNegativePriceChangeH24Pct,
      max_negative_price_change_m5_m15_m30_h1_pct: maxNegativePriceChangeM5M15M30Pct,
      weighted_ranking_eligible: 1,
      pre_momentum_eligible_count: undefined,
      offensive_momentum_gates_active: offensiveMomentumAbsoluteGates,
      offensive_momentum_skipped_for_market_breadth: true,
      offensive_momentum_volume_leg_skipped_count: undefined,
      excluded_offensive_momentum: offensiveMomentumAbsoluteGates
        ? (tokensSummary as TokenSummaryRow[]).map((t) => ({
            symbol: t.symbol,
            reason:
              offensiveMomentumExcludeReason(t, {
                marketBreadthDefensive: true,
                thresholds: thresholdBundle,
              }) ??
              "market breadth risk-off",
          }))
        : undefined,
      excluded_from_weighted_ranking: [],
      weighted_ranking: {
        ranked: [{ symbol: stableRow.symbol, score: 1, metric_scores: {} }],
        metrics_used: metricKeys,
      },
      market_h24_breadth: marketH24Breadth,
      market_breadth_stable_skipped_reason: null,
      market_breadth_defensive_active: true,
      market_breadth_on_chain_action: onChainAction,
      market_breadth_stable_mode: stableMode,
      rankings: {
        by_market_cap: byMarketCap.map((t) => t.symbol),
        by_volume_h12: byVolume.map((t) => t.symbol),
        by_price_change_h24: byPriceChange.map((t) => t.symbol),
        by_weighted_score: [stableRow.symbol],
      },
      metrics_config: rankingMetrics,
      ratios,
    };
  }

  const passesPoolLiquidity = (t: TokenSummaryRow): boolean =>
    minPoolLiquidityUsd <= 0 ||
    (typeof t.liquidity_usd === "number" && t.liquidity_usd >= minPoolLiquidityUsd);
  const passesVolatilityH24 = (t: TokenSummaryRow): boolean =>
    passesVolatilityH24Band(t.volatility_h24, minVolatilityH24Usd, maxVolatilityH24Usd);
  /** True when m5, m15, m30, and 1h are all present and each is at or below the threshold. */
  const failsShortTermPoolDrawdown = (t: TokenSummaryRow): boolean =>
    t.price_change_m5_pct != null &&
    t.price_change_m15_pct != null &&
    t.price_change_m30_pct != null &&
    t.price_change_h1_pct != null &&
    t.price_change_m5_pct <= maxNegativePriceChangeM5M15M30Pct &&
    t.price_change_m15_pct <= maxNegativePriceChangeM5M15M30Pct &&
    t.price_change_m30_pct <= maxNegativePriceChangeM5M15M30Pct &&
    t.price_change_h1_pct <= maxNegativePriceChangeM5M15M30Pct;
  /**
   * Scheduled Float changeStrategy (offensive metrics): exclude if any short horizon with data is at or below
   * `maxNegativePriceChangeM5M15M30Pct` from `getMaxNegativePriceChangeM5M15M30Pct()` (e.g. default -1 → any m5/m15/m30/h1 down ≥1% fails alone).
   * Set override `maxNegativePriceChangeM5M15M30Pct` to `0` to exclude any non‑positive move on a present window.
   */
  const failsChangeStrategyAnyShortHorizonDrawdown = (t: TokenSummaryRow): boolean => {
    if (!changeStrategyStrictShortHorizons) return false;
    return (
      (t.price_change_m5_pct != null && t.price_change_m5_pct <= maxNegativePriceChangeM5M15M30Pct) ||
      (t.price_change_m15_pct != null && t.price_change_m15_pct <= maxNegativePriceChangeM5M15M30Pct) ||
      (t.price_change_m30_pct != null && t.price_change_m30_pct <= maxNegativePriceChangeM5M15M30Pct) ||
      (t.price_change_h1_pct != null && t.price_change_h1_pct <= maxNegativePriceChangeM5M15M30Pct)
    );
  };
  const eligibleForRanking = (tokensSummary as TokenSummaryRow[]).filter((t) => {
    if (t.volume_h12 < minVolumeH12Usd) return false;
    if (!passesPoolLiquidity(t)) return false;
    if (!passesVolatilityH24(t)) return false;
    if (t.price_change_h24_pct != null && t.price_change_h24_pct <= maxNegativePriceChangeH24Pct) return false;
    if (failsChangeStrategyAnyShortHorizonDrawdown(t)) return false;
    if (failsShortTermPoolDrawdown(t)) return false;
    return true;
  });
  const excludedFromRanking = (tokensSummary as TokenSummaryRow[]).filter((t) => {
    if (t.volume_h12 < minVolumeH12Usd) return true;
    if (!passesPoolLiquidity(t)) return true;
    if (!passesVolatilityH24(t)) return true;
    if (t.price_change_h24_pct != null && t.price_change_h24_pct <= maxNegativePriceChangeH24Pct) return true;
    if (failsChangeStrategyAnyShortHorizonDrawdown(t)) return true;
    if (failsShortTermPoolDrawdown(t)) return true;
    return false;
  });

  const momentumGateCtx: OffensiveMomentumExcludeContext | undefined = offensiveMomentumAbsoluteGates
    ? { thresholds: thresholdBundle }
    : undefined;

  const momentumEligible = offensiveMomentumAbsoluteGates
    ? eligibleForRanking.filter((t) => passesOffensiveMomentumGates(t, momentumGateCtx))
    : eligibleForRanking;
  const excludedOffensiveMomentum = offensiveMomentumAbsoluteGates
    ? eligibleForRanking
        .filter((t) => !passesOffensiveMomentumGates(t, momentumGateCtx))
        .map((t) => ({
          symbol: t.symbol,
          reason: offensiveMomentumExcludeReason(t, momentumGateCtx) ?? "failed offensive momentum gate",
        }))
    : undefined;

  /**
   * Scheduled offensive: composite compares against the full **pre-momentum** cohort (`eligibleForRanking`) — min–max or
   * baseline-centered per {@link buildTokenComparison}’s `weightedScoreBaseline`. Momentum gates only decide who may be
   * picked; scores come from that wider set so a lone momentum survivor is not pseudo-scored in isolation.
   */
  // Offensive (momentum-gated) path uses offensive absolute bounds when enabled; baseline μ otherwise.
  const activeBounds = offensiveMomentumAbsoluteGates ? options?.weightedScoreBounds : undefined;
  const rankingOpts =
    options?.weightedScoreBaseline || activeBounds
      ? {
          baselineByMetric: options?.weightedScoreBaseline,
          absoluteBoundsByMetric: activeBounds,
        }
      : undefined;
  const weightedRanking = offensiveMomentumAbsoluteGates
    ? (() => {
        const full = rankTokensByWeightedMetrics(eligibleForRanking, rankingMetrics, rankingOpts);
        const bySymbol = new Map(full.ranked.map((r) => [r.symbol, r]));
        const ranked = momentumEligible
          .map((t) => bySymbol.get(t.symbol))
          .filter((r): r is (typeof full.ranked)[number] => r !== undefined)
          .sort((a, b) => b.score - a.score);
        return { ...full, ranked };
      })()
    : rankTokensByWeightedMetrics(momentumEligible, rankingMetrics, rankingOpts);

  const excludeReason = (t: TokenSummaryRow): string => {
    if (t.volume_h12 < minVolumeH12Usd) return `volume_h12 < ${minVolumeH12Usd}`;
    if (!passesPoolLiquidity(t))
      return `liquidity_usd < ${minPoolLiquidityUsd} (or missing)`;
    if (!passesVolatilityH24(t)) {
      const v = t.volatility_h24;
      const vStr = typeof v === "number" && Number.isFinite(v) ? v.toFixed(4) : "n/a";
      if (minVolatilityH24Usd > 0 && (typeof v !== "number" || !Number.isFinite(v) || v < minVolatilityH24Usd)) {
        return `volatility_h24 ${vStr} < ${minVolatilityH24Usd} (pool h24 volume ÷ reserve_in_usd or base+quote liq)`;
      }
      if (maxVolatilityH24Usd > 0 && (typeof v !== "number" || !Number.isFinite(v) || v > maxVolatilityH24Usd)) {
        return `volatility_h24 ${vStr} > ${maxVolatilityH24Usd} (pool h24 volume ÷ reserve_in_usd or base+quote liq)`;
      }
      return `volatility_h24 ${vStr} outside min/max turnover band`;
    }
    if (t.price_change_h24_pct != null && t.price_change_h24_pct <= maxNegativePriceChangeH24Pct)
      return `price_change_h24_pct ${t.price_change_h24_pct}% <= ${maxNegativePriceChangeH24Pct}% (24h down move)`;
    if (failsChangeStrategyAnyShortHorizonDrawdown(t)) {
      return `changeStrategy short horizon: at least one of m5/m15/m30/h1 <= ${maxNegativePriceChangeM5M15M30Pct}% (m5=${t.price_change_m5_pct}%, m15=${t.price_change_m15_pct}%, m30=${t.price_change_m30_pct}%, h1=${t.price_change_h1_pct}%)`;
    }
    if (failsShortTermPoolDrawdown(t)) {
      return `pool m5/m15/m30/h1 each <= ${maxNegativePriceChangeM5M15M30Pct}% (m5=${t.price_change_m5_pct}%, m15=${t.price_change_m15_pct}%, m30=${t.price_change_m30_pct}%, h1=${t.price_change_h1_pct}%)`;
    }
    return "";
  };

  return {
    tokens_summary: tokensSummary,
    min_volume_h12_usd: minVolumeH12Usd,
    min_pool_liquidity_usd: minPoolLiquidityUsd,
    min_volatility_h24_usd: minVolatilityH24Usd,
    max_volatility_h24_usd: maxVolatilityH24Usd,
    max_negative_price_change_h24_pct: maxNegativePriceChangeH24Pct,
    max_negative_price_change_m5_m15_m30_h1_pct: maxNegativePriceChangeM5M15M30Pct,
    weighted_ranking_eligible: momentumEligible.length,
    pre_momentum_eligible_count: offensiveMomentumAbsoluteGates ? eligibleForRanking.length : undefined,
    offensive_momentum_gates_active: offensiveMomentumAbsoluteGates,
    offensive_momentum_exclude_price_change_h24_pct_gte: offensiveMomentumAbsoluteGates
      ? thresholdBundle.offensiveMomentumExcludePriceChangeH24PctGte
      : undefined,
    offensive_momentum_volume_leg_skipped_count: offensiveMomentumAbsoluteGates
      ? eligibleForRanking.filter((t) => !(t.volume_m15 > 0 && t.volume_m30 > 0)).length
      : undefined,
    excluded_offensive_momentum: excludedOffensiveMomentum,
    excluded_from_weighted_ranking: excludedFromRanking.map((t) => ({
      symbol: t.symbol,
      volume_h12: t.volume_h12,
      liquidity_usd: t.liquidity_usd,
      pool_volume_h24_usd: t.pool_volume_h24_usd,
      pool_reserve_in_usd: t.pool_reserve_in_usd,
      volatility_h24: t.volatility_h24,
      price_change_h1_pct: t.price_change_h1_pct,
      price_change_h24_pct: t.price_change_h24_pct,
      price_change_m5_pct: t.price_change_m5_pct,
      price_change_m15_pct: t.price_change_m15_pct,
      price_change_m30_pct: t.price_change_m30_pct,
      reason: excludeReason(t),
    })),
    rankings: {
      by_market_cap: byMarketCap.map((t) => t.symbol),
      by_volume_h12: byVolume.map((t) => t.symbol),
      by_price_change_h24: byPriceChange.map((t) => t.symbol),
      by_weighted_score: weightedRanking.ranked.map((r) => r.symbol),
    },
    weighted_ranking: weightedRanking,
    metrics_config: rankingMetrics,
    market_h24_breadth: marketH24Breadth,
    market_breadth_stable_skipped_reason: marketH24Breadth.defensive ? marketBreadthStableSkippedReason : null,
    market_breadth_defensive_active: false,
    ratios,
  };
}

function metricRawForRanking(t: TokenSummaryRow, k: string): number | null {
  const raw = t[k as keyof TokenSummaryRow];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number" && Number.isNaN(raw)) return null;
  return typeof raw === "number" ? raw : null;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Rank tokens by a weighted composite of metrics. Normalizes each metric to 0–1, applies weights, sums for composite score.
 *
 * **Default:** min–max across tokens **with data** per metric.
 *
 * **Baseline mode** (`baselineByMetric`): uses cohort range `max − min` as spread but centers so raw **μ** maps to **0.5**
 * before applying `higherIsBetter`: `clamp01(0.5 + (v − μ) / range)`. Missing μ for a key falls back to min–max for that key.
 *
 * **Missing (`null`) values** are not coerced to 0 before normalization — missing → worst score (**0**) on that metric’s axis.
 *
 * **No spread** (single token, or ≥2 tokens with identical values): normalization is undefined; `higherIsBetter` metrics use **1**;
 * `higherIsBetter: false` uses **0.5** (neutral tie).
 */
function rankTokensByWeightedMetrics(
  tokens: TokenSummaryRow[],
  metrics: TokenRankingMetricsMap,
  opts?: {
    baselineByMetric?: Record<string, number>;
    absoluteBoundsByMetric?: Record<string, { lo: number; hi: number }>;
  }
): {
  ranked: Array<{ symbol: string; score: number; metric_scores: Record<string, number> }>;
  metrics_used: string[];
} {
  const baselineByMetric = opts?.baselineByMetric;
  const absoluteBoundsByMetric = opts?.absoluteBoundsByMetric;
  const metricKeys = Object.keys(metrics) as string[];
  const metricVals: Record<string, Array<number | null>> = {};
  for (const k of metricKeys) {
    metricVals[k] = tokens.map((t) => metricRawForRanking(t, k));
  }

  const normalized: Record<string, number[]> = {};
  for (const k of metricKeys) {
    const vals = metricVals[k];
    const present = vals.filter((v): v is number => v !== null);
    const cfg = metrics[k];
    if (!cfg) continue;
    if (present.length === 0) {
      normalized[k] = tokens.map(() => 0);
      continue;
    }
    // Absolute mode: fixed per-metric {lo, hi}; independent of the cohort, so no min–max and no single-token 1.0 shortcut.
    const bounds = absoluteBoundsByMetric?.[k];
    if (bounds && bounds.hi > bounds.lo) {
      const span = bounds.hi - bounds.lo;
      normalized[k] = vals.map((v) => {
        if (v === null) return 0;
        const axis01 = clamp01((v - bounds.lo) / span);
        return cfg.higherIsBetter ? axis01 : 1 - axis01;
      });
      continue;
    }
    const min = Math.min(...present);
    const max = Math.max(...present);
    const hasSpread = present.length >= 2 && max > min;
    const range = max - min;
    const mu =
      baselineByMetric != null && typeof baselineByMetric[k] === "number" && Number.isFinite(baselineByMetric[k])
        ? baselineByMetric[k]
        : undefined;
    normalized[k] = vals.map((v) => {
      if (v === null) return 0;
      if (!hasSpread) {
        return cfg.higherIsBetter ? 1 : 0.5;
      }
      let axis01: number;
      if (mu !== undefined) {
        axis01 = clamp01(0.5 + (v - mu) / range);
      } else {
        axis01 = (v - min) / range;
      }
      return cfg.higherIsBetter ? axis01 : 1 - axis01;
    });
  }

  const scored = tokens.map((t, i) => {
    let total = 0;
    const metricScoresOut: Record<string, number> = {};
    for (const k of metricKeys) {
      const w = metrics[k]?.weight;
      if (w === undefined) continue;
      const n = normalized[k]?.[i];
      if (n === undefined) continue;
      total += w * n;
      metricScoresOut[k] = Math.round(n * 1000) / 1000;
    }
    return {
      symbol: t.symbol,
      score: Math.round(total * 1000) / 1000,
      metric_scores: metricScoresOut,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    ranked: scored,
    metrics_used: metricKeys,
  };
}

/**
 * Fetch and return extracted token data (tokens + pools with price_change_percentage, etc).
 * Exported for direct use (e.g. demeter --coingecko).
 */
export async function fetchTokenData(
  contractAddresses: string[] = TOKEN_ADDRESS_ARRAY,
  network: string = NETWORK,
  options?: { poolByToken?: Map<string, string>; strategyRegistryKey?: "FloatStrategy" | "FloatStrategyV4" }
): Promise<unknown> {
  const poolMap =
    options?.poolByToken ??
    getPoolByTokenMapForStrategyRegistry(options?.strategyRegistryKey ?? "FloatStrategy");
  return getTokenData(contractAddresses, network, poolMap);
}

/**
 * Fetch token data and return full comparison including weighted ranking.
 * Exported for direct use (e.g. demeter --coingecko --compare).
 */
export async function fetchTokenComparison(
  contractAddresses: string[] = TOKEN_ADDRESS_ARRAY,
  network: string = NETWORK,
  options?: {
    rankingMetrics?: TokenRankingMetricsMap;
    changeStrategyStrictShortHorizons?: boolean;
    offensiveMomentumAbsoluteGates?: boolean;
    currentStrategyTokenAddress?: string | null;
    /** When true, apply market-breadth stable path even if current token is not negative on 24h. */
    forceMarketBreadthStable?: boolean;
    /** When true, skip cohort market-breadth stable rotation (Triton / offensive-only paths). */
    disableMarketBreadth?: boolean;
    /** V3: USDC; V4: WETH + exitStrategyToStable. */
    marketBreadthStableMode?: MarketBreadthStableMode;
    /**
     * Per-metric μ for baseline-centered scoring; `null` disables. Omit to use {@link resolveWeightedScoreBaseline} from env/config.
     */
    offensiveWeightedScoreBaseline?: Record<string, number> | null;
    /**
     * Fixed per-metric {lo, hi} for absolute scoring; `null` disables. Omit to use {@link resolveWeightedScoreBounds} from env/config.
     */
    offensiveWeightedScoreBounds?: Record<string, { lo: number; hi: number }> | null;
    /** Pool lookup for token addresses (default V3 {@link POOL_ADDRESS_BY_TOKEN_ADDRESS}). */
    poolByToken?: Map<string, string>;
    /** Float V3 vs Float V4 / Triton threshold bundle. */
    rankingProfile?: FloatRankingProfile;
    /** Pre-resolved thresholds; overrides rankingProfile when set. */
    rankingThresholds?: RankingEligibilityThresholds;
  }
): Promise<unknown> {
  const poolMap = options?.poolByToken ?? POOL_ADDRESS_BY_TOKEN_ADDRESS;
  const data = await getTokenData(contractAddresses, network, poolMap);
  const weightedScoreBaseline = resolveWeightedScoreBaseline(options?.offensiveWeightedScoreBaseline);
  const weightedScoreBounds = resolveWeightedScoreBounds(options?.offensiveWeightedScoreBounds);
  return buildTokenComparison(data, options?.rankingMetrics ?? getTokenRankingMetrics(), {
    changeStrategyStrictShortHorizons: options?.changeStrategyStrictShortHorizons,
    offensiveMomentumAbsoluteGates: options?.offensiveMomentumAbsoluteGates,
    currentStrategyTokenAddress: options?.currentStrategyTokenAddress,
    forceMarketBreadthStable: options?.forceMarketBreadthStable,
    disableMarketBreadth: options?.disableMarketBreadth,
    marketBreadthStableMode: options?.marketBreadthStableMode,
    rankingProfile: options?.rankingProfile,
    rankingThresholds: options?.rankingThresholds,
    weightedScoreBaseline,
    weightedScoreBounds,
  });
}

/**
 * Token comparison for Triton V4 universe: {@link TRITON_V4_TOKEN_ADDRESS_ARRAY}, offensive metrics only (no market-breadth stable path).
 * Demeter Float V4 pipeline uses {@link fetchTokenComparison} with `marketBreadthStableMode: "v4_weth"` instead.
 */
export async function fetchTokenComparisonV4(
  network: string = NETWORK,
  options?: {
    currentStrategyTokenAddress?: string | null;
    offensiveWeightedScoreBaseline?: Record<string, number> | null;
    disableMarketBreadth?: boolean;
  }
): Promise<unknown> {
  return fetchTokenComparison(TRITON_V4_TOKEN_ADDRESS_ARRAY, network, {
    rankingMetrics: getOffensiveTokenRankingMetrics(),
    changeStrategyStrictShortHorizons: true,
    offensiveMomentumAbsoluteGates: true,
    disableMarketBreadth: options?.disableMarketBreadth ?? true,
    rankingProfile: "triton_v4",
    poolByToken: POOL_ADDRESS_BY_TOKEN_V4,
    currentStrategyTokenAddress: options?.currentStrategyTokenAddress ?? null,
    offensiveWeightedScoreBaseline: options?.offensiveWeightedScoreBaseline,
  });
}

/**
 * Token comparison for Triton V4 universe using default/defensive ranking metrics
 * ({@link DEFAULT_TOKEN_RANKING_METRICS} via {@link getTokenRankingMetrics}).
 */
export async function fetchTokenComparisonV4Default(
  network: string = NETWORK,
  options?: {
    currentStrategyTokenAddress?: string | null;
  }
): Promise<unknown> {
  return fetchTokenComparison(TRITON_V4_TOKEN_ADDRESS_ARRAY, network, {
    rankingMetrics: getTokenRankingMetrics(),
    poolByToken: POOL_ADDRESS_BY_TOKEN_V4,
    disableMarketBreadth: true,
    rankingProfile: "triton_v4",
    currentStrategyTokenAddress: options?.currentStrategyTokenAddress ?? null,
  });
}

/**
 * Historical market chart (prices / market_caps / total_volumes) per contract.
 * CoinGecko path is `/coins/{platform}/contract/{contract_address}/market_chart/range` with **one** contract per request.
 */
async function getMarketChartRange(
  contractAddresses: string[],
  network: string = COINGECKO_NETWORK,
  fromDate: string,
  toDate: string,
  vsCurrency: string = "usd",
  interval: "hourly" | "daily" = "daily"
): Promise<{
  chartsByContract: Record<string, unknown>;
  fetchErrors?: Record<string, string>;
}> {
  if (!coinGeckoApiKey()) {
    throw new Error('COIN_GECKO_API_KEY is required in environment variables');
  }
  const headers = coinGeckoHeaders();
  const addrs = [...new Set(contractAddresses.map((a) => normalizeHexAddress(a)).filter(Boolean))];
  if (addrs.length === 0) {
    throw new Error("At least one contract address is required for market_chart/range");
  }
  const q = new URLSearchParams({
    vs_currency: vsCurrency,
    from: fromDate,
    to: toDate,
    interval,
    precision: "18",
  });
  const chartsByContract: Record<string, unknown> = {};
  const fetchErrors: Record<string, string> = {};
  for (const addr of addrs) {
    const url = `${COINGECKO_API_BASE}/coins/${encodeURIComponent(network)}/contract/${encodeURIComponent(addr)}/market_chart/range?${q.toString()}`;
    const response = await fetch(url, { headers });
    if (!response.ok) {
      fetchErrors[addr] = `${response.status} ${response.statusText}`;
      continue;
    }
    chartsByContract[addr] = await response.json();
  }
  if (Object.keys(chartsByContract).length === 0) {
    throw new Error(
      `CoinGecko market_chart/range failed for all addresses: ${JSON.stringify(fetchErrors)}`
    );
  }
  return Object.keys(fetchErrors).length
    ? { chartsByContract, fetchErrors }
    : { chartsByContract };
}

/**
 * Pool stats (liquidity, volume, transactions, price changes) by pool address.
 * Uses `/networks/{network}/pools/{address}` — not `/info` (that endpoint is token metadata only per CoinGecko docs).
 */
async function getPoolInfo(
  poolAddress: string,
  network: string = COINGECKO_NETWORK
): Promise<unknown> {
  if (!coinGeckoApiKey()) {
    throw new Error('COIN_GECKO_API_KEY is required in environment variables');
  }
  const addr = normalizeHexAddress(poolAddress);
  const poolQuery = new URLSearchParams({
    include: "base_token,quote_token,dex",
    include_composition: "true",
    include_volume_breakdown: "true",
  });
  const url = `${COINGECKO_API_BASE}/onchain/networks/${encodeURIComponent(network)}/pools/${encodeURIComponent(addr)}?${poolQuery.toString()}`;
  const headers = coinGeckoHeaders();
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(formatCoinGeckoHttpError(response.status, response.statusText, "pools/{address}"));
  }
  return response.json();
}

/**
 * CoinGecko Action Provider
 */
export function coingeckoActionProvider() {
  return customActionProvider([
    {
      name: "coingecko_getTokenPrice",
      description: "Get the current price of a token by its contract address on Base.",
      schema: z.object({
        contractAddress: z
          .string()
          .describe("The token contract address"),
        network: z
          .string()
          .nullable()
          .default(COINGECKO_NETWORK)
          .describe("The blockchain network (e.g., 'base', 'ethereum', 'arbitrum', 'optimism', 'polygon')"),
        vsCurrency: z
          .string()
          .nullable()
          .default("usd")
          .describe("The currency to get price in (e.g., 'usd', 'eth')"),
      }),
      invoke: async (_walletProvider, args: { contractAddress: string; network?: string | null; vsCurrency?: string | null }) => {
        try {
          const network = args.network ?? COINGECKO_NETWORK;
          const vsCurrency = args.vsCurrency ?? "usd";
          const price = await getTokenPrice(args.contractAddress, network, vsCurrency);
          return JSON.stringify({
            success: true,
            data: {
              contractAddress: args.contractAddress,
              network,
              vsCurrency,
              price,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error fetching price",
          });
        }
      },
    },
    {
      name: "coingecko_getMultipleTokenPrices",
      description: "Get prices for multiple tokens on Base. Uses configured token addresses when none provided.",
      schema: z.object({
        contractAddresses: z
          .array(z.string())
          .nullable()
          .default(TOKEN_ADDRESS_ARRAY)
          .describe("Token contract addresses; defaults to configured tokens on Base"),
        network: z
          .string()
          .nullable()
          .default(NETWORK)
          .describe("Blockchain network (default: base)"),
        vsCurrency: z
          .string()
          .nullable()
          .default("usd")
          .describe("Quote currency"),
      }),
      invoke: async (_walletProvider, args: { contractAddresses?: string[] | null; network?: string | null; vsCurrency?: string | null }) => {
        try {
          const addresses = (args.contractAddresses?.length ?? 0) > 0 ? (args.contractAddresses ?? TOKEN_ADDRESS_ARRAY) : TOKEN_ADDRESS_ARRAY;
          const network = args.network ?? NETWORK;
          const vsCurrency = args.vsCurrency ?? "usd";
          const prices = await getMultipleTokenPrices(addresses, network, vsCurrency);
          return JSON.stringify({
            success: true,
            data: {
              prices,
              network,
              vsCurrency,
              timestamp: new Date().toISOString(),
            },
          });
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error fetching prices",
          });
        }
      },
    },
    {
      name: "coingecko_compareTokens",
      description: "Compare and rank tokens. Returns weighted composite ranking (liquidity 30%, volume 25%, price_change 20%, market_cap 15%, buy_sell_ratio 10%), per-metric rankings, token summary, and ratios. Use for token comparison and prioritization. Uses configured token addresses when none provided.",
      schema: z.object({
        contractAddresses: z
          .array(z.string())
          .nullable()
          .default(TOKEN_ADDRESS_ARRAY)
          .describe("Token contract addresses to compare; defaults to configured tokens on Base"),
        network: z
          .string()
          .nullable()
          .default(NETWORK)
          .describe("Blockchain network (default: base)"),
      }),
      invoke: async (_walletProvider, args: { contractAddresses?: string[] | null; network?: string | null }) => {
        try {
          const addresses = (args.contractAddresses?.length ?? 0) > 0 ? (args.contractAddresses ?? TOKEN_ADDRESS_ARRAY) : TOKEN_ADDRESS_ARRAY;
          const data = await getTokenData(addresses, args.network ?? NETWORK);
          const comparison = buildTokenComparison(data);
          const out = JSON.stringify({ success: true, comparison, timestamp: new Date().toISOString() });
          return truncateToolResponse(out);
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error comparing tokens",
          });
        }
      },
    },
    {
      name: "coingecko_getTokenData",
      description: "Get token data on Base. Returns: token name, volume_usd.h24, market_cap_usd; pool quote_token_liquidity_usd, base_token_liquidity_usd, price_change_percentage, transactions, volume_usd (h1,h6,h24). Uses configured token addresses when none provided.",
      schema: z.object({
        contractAddresses: z
          .array(z.string())
          .nullable()
          .default(TOKEN_ADDRESS_ARRAY)
          .describe("Token contract addresses; defaults to configured tokens on Base"),
        network: z
          .string()
          .nullable()
          .default(NETWORK)
          .describe("Blockchain network (default: base)"),
      }),
      invoke: async (_walletProvider, args: { contractAddresses?: string[] | null; network?: string | null }) => {
        try {
          const addresses = (args.contractAddresses?.length ?? 0) > 0 ? (args.contractAddresses ?? TOKEN_ADDRESS_ARRAY) : TOKEN_ADDRESS_ARRAY;
          const data = await getTokenData(addresses, args.network ?? NETWORK);
          const out = JSON.stringify({ success: true, data, timestamp: new Date().toISOString() });
          return truncateToolResponse(out);
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error fetching token data",
          });
        }
      },
    },
    {
      name: "coingecko_getMarketChartRange",
      description:
        "Get historical price, market cap, and volume (market_chart/range) per token contract. CoinGecko allows one contract per request; response is { chartsByContract: { [lowercaseAddress]: { prices, market_caps, total_volumes } }, fetchErrors? } when any address fails.",
      schema: z.object({
        contractAddresses: z
          .array(z.string())
          .nullable()
          .default(TOKEN_ADDRESS_ARRAY)
          .describe("Token contract addresses; defaults to configured tokens on Base"),
        network: z
          .string()
          .nullable()
          .default(NETWORK)
          .describe("Blockchain network (default: base)"),
        fromDate: z
          .string()
          .describe("Start date as YYYY-MM-DD or Unix timestamp"),
        toDate: z
          .string()
          .describe("End date as YYYY-MM-DD or Unix timestamp"),
        vsCurrency: z.string().nullable().default("usd").describe("Quote currency"),
        interval: z.enum(["hourly", "daily"]).nullable().default("daily").describe("Data point interval"),
      }),
      invoke: async (_walletProvider, args: {
        contractAddresses?: string[] | null;
        network?: string | null;
        fromDate: string;
        toDate: string;
        vsCurrency?: string | null;
        interval?: "hourly" | "daily" | null;
      }) => {
        try {
          const addresses = (args.contractAddresses?.length ?? 0) > 0 ? (args.contractAddresses ?? TOKEN_ADDRESS_ARRAY) : TOKEN_ADDRESS_ARRAY;
          const data = await getMarketChartRange(
            addresses,
            args.network ?? NETWORK,
            args.fromDate,
            args.toDate,
            args.vsCurrency ?? "usd",
            args.interval ?? "daily"
          );
          const out = JSON.stringify({ success: true, data, timestamp: new Date().toISOString() });
          return truncateToolResponse(out);
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error fetching market chart",
          });
        }
      },
    },
    {
      name: "coingecko_getPoolInfo",
      description:
        "Get pool stats (liquidity, volume breakdown, transactions, price changes) on Base via onchain `/pools/{address}` with volume breakdown. When no pool address given, returns configured tokens’ token+pool data (same as getTokenData). For token socials/metadata only, CoinGecko uses `/pools/{address}/info` instead.",
      schema: z.object({
        poolAddress: z
          .string()
          .nullable()
          .optional()
          .describe("Pool contract address; when omitted, fetches top pools for configured token addresses"),
        network: z
          .string()
          .nullable()
          .default(NETWORK)
          .describe("Blockchain network (default: base)"),
      }),
      invoke: async (_walletProvider, args: { poolAddress?: string | null; network?: string | null }) => {
        try {
          let data: unknown;
          const network = args.network ?? NETWORK;
          if (args.poolAddress) {
            data = await getPoolInfo(args.poolAddress, network);
          } else {
            data = await getTokenData(TOKEN_ADDRESS_ARRAY, network);
          }
          const out = JSON.stringify({ success: true, data, timestamp: new Date().toISOString() });
          return truncateToolResponse(out);
        } catch (error) {
          return JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : "Unknown error fetching pool info",
          });
        }
      },
    },
  ]);
}



