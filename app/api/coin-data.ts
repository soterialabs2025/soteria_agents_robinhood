// Set up API key with fallback and validation
const CG_API_KEY = process.env.CG_API_KEY;
if (!CG_API_KEY) {
  throw new Error('CG_API_KEY is required in environment variables');
}

//https://pro-api.coingecko.com/api/v3/onchain/networks/base/tokens/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b

// const options = {method: 'GET', headers: {'x-cg-pro-api-key': 'CG-sU3QUcpw4DJPHMPKjniknphN'}};

// const options = {method: 'GET', headers: {'x-cg-pro-api-key': 'CG-sU3QUcpw4DJPHMPKjniknphN'}};

// fetch('https://pro-api.coingecko.com/api/v3/onchain/networks/base/tokens/multi/0x1bc0c42215582d5a085795f4badbac3ff36d1bcb%2C0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', options)
//   .then(res => res.json())
//   .then(res => console.log(res))
//   .catch(err => console.error(err));
// const data = {
//   "data": [
//     {
//       "id": "base_0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
//       "type": "token",
//       "attributes": {
//         "address": "0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
//         "name": "tokenbot",
//         "symbol": "CLANKER",
//         "decimals": 18,
//         "image_url": "https://coin-images.coingecko.com/coins/images/51440/large/CLANKER.png?1731232869",
//         "coingecko_coin_id": "tokenbot-2",
//         "total_supply": "1000000000000000000000000.0",
//         "normalized_total_supply": "1000000.0",
//         "price_usd": "38.8448323991",
//         "fdv_usd": "38311774.7315502",
//         "total_reserve_in_usd": "2761173.3384391037381825979722397966",
//         "volume_usd": {
//           "h24": "11865899.526529"
//         },
//         "market_cap_usd": "38184139.1094478"
//       },
//       "relationships": {
//         "top_pools": {
//           "data": [
//             {
//               "id": "base_0xc1a6fbedae68e1472dbb91fe29b51f7a0bd44f97",
//               "type": "pool"
//             }
//           ]
//         }
//       }
//     },
//     {
//       "id": "base_0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
//       "type": "token",
//       "attributes": {
//         "address": "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
//         "name": "BankrCoin",
//         "symbol": "BNKR",
//         "decimals": 18,
//         "image_url": "https://coin-images.coingecko.com/coins/images/52626/large/bankr-static.png?1736405365",
//         "coingecko_coin_id": "bankercoin-2",
//         "total_supply": "100000000000000000000000000000.0",
//         "normalized_total_supply": "100000000000.0",
//         "price_usd": "0.001020991982",
//         "fdv_usd": "98997842.1882073",
//         "total_reserve_in_usd": "2433176.679712124711004184193155384938",
//         "volume_usd": {
//           "h24": "13894592.4950528"
//         },
//         "market_cap_usd": "102099198.2"
//       },
//       "relationships": {
//         "top_pools": {
//           "data": [
//             {
//               "id": "base_0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703",
//               "type": "pool"
//             }
//           ]
//         }
//       }
//     }
//   ],
//   "included": [
//     {
//       "id": "base_0xc1a6fbedae68e1472dbb91fe29b51f7a0bd44f97",
//       "type": "pool",
//       "attributes": {
//         "base_token_price_usd": "38.8448323990506",
//         "base_token_price_native_currency": "0.0193443617000655",
//         "base_token_balance": "59577.2582637957",
//         "base_token_liquidity_usd": "2314718.0808249437",
//         "quote_token_price_usd": "2008.07",
//         "quote_token_price_native_currency": "1.0",
//         "quote_token_balance": "545.727466834399",
//         "quote_token_liquidity_usd": "1096071.788038217",
//         "base_token_price_quote_token": "0.0193443617",
//         "quote_token_price_base_token": "51.694649609",
//         "address": "0xc1a6fbedae68e1472dbb91fe29b51f7a0bd44f97",
//         "name": "CLANKER / WETH 1%",
//         "pool_created_at": "2024-11-08T20:43:33Z",
//         "fdv_usd": "38311774.7315989",
//         "market_cap_usd": "38311774.7315989",
//         "price_change_percentage": {
//           "m5": "1.082",
//           "m15": "2.749",
//           "m30": "2.188",
//           "h1": "2.162",
//           "h6": "17.385",
//           "h24": "18.372"
//         },
//         "transactions": {
//           "m5": {
//             "buys": 34,
//             "sells": 0,
//             "buyers": 12,
//             "sellers": 0
//           },
//           "m15": {
//             "buys": 34,
//             "sells": 9,
//             "buyers": 12,
//             "sellers": 5
//           },
//           "m30": {
//             "buys": 35,
//             "sells": 46,
//             "buyers": 13,
//             "sellers": 14
//           },
//           "h1": {
//             "buys": 45,
//             "sells": 299,
//             "buyers": 20,
//             "sellers": 73
//           },
//           "h6": {
//             "buys": 999,
//             "sells": 1365,
//             "buyers": 309,
//             "sellers": 271
//           },
//           "h24": {
//             "buys": 1905,
//             "sells": 2207,
//             "buyers": 430,
//             "sellers": 408
//           }
//         },
//         "volume_usd": {
//           "m5": "20088.2262169722",
//           "m15": "22954.7443851421",
//           "m30": "35656.8701417087",
//           "h1": "492762.472294057",
//           "h6": "3609466.08491658",
//           "h24": "5222826.56663722"
//         },
//         "reserve_in_usd": "3408224.5724"
//       },
//       "relationships": {
//         "base_token": {
//           "data": {
//             "id": "base_0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
//             "type": "token"
//           }
//         },
//         "quote_token": {
//           "data": {
//             "id": "base_0x4200000000000000000000000000000000000006",
//             "type": "token"
//           }
//         },
//         "dex": {
//           "data": {
//             "id": "uniswap-v3-base",
//             "type": "dex"
//           }
//         }
//       }
//     },
//     {
//       "id": "base_0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703",
//       "type": "pool",
//       "attributes": {
//         "base_token_price_usd": "0.00102099198208923",
//         "base_token_price_native_currency": "0.000000508485019574109",
//         "base_token_balance": "1828672292.54073",
//         "base_token_liquidity_usd": "1867487.7980787382",
//         "quote_token_price_usd": "2008.37",
//         "quote_token_price_native_currency": "1.0",
//         "quote_token_balance": "1015.28402383345",
//         "quote_token_liquidity_usd": "2039065.9749463857",
//         "base_token_price_quote_token": "0.0000005084850196",
//         "quote_token_price_base_token": "1966626.27512128",
//         "address": "0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703",
//         "name": "BNKR / WETH 1%",
//         "pool_created_at": "2024-12-03T04:44:53Z",
//         "fdv_usd": "98997842.1795554",
//         "market_cap_usd": "102099198.2",
//         "price_change_percentage": {
//           "m5": "0",
//           "m15": "-0.3",
//           "m30": "-0.524",
//           "h1": "-4.481",
//           "h6": "-3.095",
//           "h24": "4.254"
//         },
//         "transactions": {
//           "m5": {
//             "buys": 0,
//             "sells": 1,
//             "buyers": 0,
//             "sellers": 1
//           },
//           "m15": {
//             "buys": 0,
//             "sells": 4,
//             "buyers": 0,
//             "sellers": 3
//           },
//           "m30": {
//             "buys": 3,
//             "sells": 24,
//             "buyers": 2,
//             "sellers": 6
//           },
//           "h1": {
//             "buys": 35,
//             "sells": 61,
//             "buyers": 9,
//             "sellers": 13
//           },
//           "h6": {
//             "buys": 597,
//             "sells": 419,
//             "buyers": 143,
//             "sellers": 138
//           },
//           "h24": {
//             "buys": 2625,
//             "sells": 2319,
//             "buyers": 481,
//             "sellers": 475
//           }
//         },
//         "volume_usd": {
//           "m5": "241.2093557686",
//           "m15": "1045.5626656987",
//           "m30": "5975.3712211602",
//           "h1": "44409.8866456377",
//           "h6": "980677.959803992",
//           "h24": "5600912.46431808"
//         },
//         "reserve_in_usd": "3906028.6057"
//       },
//       "relationships": {
//         "base_token": {
//           "data": {
//             "id": "base_0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
//             "type": "token"
//           }
//         },
//         "quote_token": {
//           "data": {
//             "id": "base_0x4200000000000000000000000000000000000006",
//             "type": "token"
//           }
//         },
//         "dex": {
//           "data": {
//             "id": "uniswap-v3-base",
//             "type": "dex"
//           }
//         }
//       }
//     }
//   ]
// }

// const options = {method: 'GET', headers: {'x-cg-pro-api-key': 'CG-sU3QUcpw4DJPHMPKjniknphN'}};

// fetch('https://pro-api.coingecko.com/api/v3/coins/base/contract/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b%2C%200x1bc0c42215582d5a085795f4badbac3ff36d1bcb/market_chart/range?vs_currency=usd&from=2024-01-01&to=2024-12-31&interval=hourly&precision=18', options)
//   .then(res => res.json())
//   .then(res => console.log(res))
//   .catch(err => console.error(err))

// const data = {
// {
//   "prices": [
//     [
//       1704067241331,
//       42261.0406175669
//     ],
//     [
//       1704070847420,
//       42493.2764087546
//     ],
//     [
//       1704074443652,
//       42654.0731066594
//     ]
//   ],
//   "market_caps": [
//     [
//       1704067241331,
//       827596236151.196
//     ],
//     [
//       1704070847420,
//       831531023621.411
//     ],
//     [
//       1704074443652,
//       835499399014.932
//     ]
//   ],
//   "total_volumes": [
//     [
//       1704067241331,
//       14305769170.9498
//     ],
//     [
//       1704070847420,
//       14130205376.1709
//     ],
//     [
//       1704074443652,
//       13697382902.2424
//     ]
//   ]
// }

// const options = {method: 'GET', headers: {'x-cg-pro-api-key': 'CG-sU3QUcpw4DJPHMPKjniknphN'}};

// fetch('https://pro-api.coingecko.com/api/v3/onchain/networks/base/pools/0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703/info?include=pool', options)
//   .then(res => res.json())
//   .then(res => console.log(res))
//   .catch(err => console.error(err));

//   {
//     "data": [
//       {
//         "id": "eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
//         "type": "token",
//         "attributes": {
//           "address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
//           "name": "Wrapped Ether",
//           "symbol": "WETH",
//           "image_url": "https://assets.coingecko.com/coins/images/2518/small/weth.png?1696503332",
//           "image": {
//             "thumb": "https://assets.coingecko.com/coins/images/2518/thumb/weth.png?1696503332",
//             "small": "https://assets.coingecko.com/coins/images/2518/small/weth.png?1696503332",
//             "large": "https://assets.coingecko.com/coins/images/2518/large/weth.png?1696503332"
//           },
//           "coingecko_coin_id": "weth",
//           "websites": [
//             "https://weth.io/"
//           ],
//           "description": "WETH is the tokenized/packaged form of ETH that you use to pay for items when you interact with Ethereum dApps...",
//           "gt_score": 92.6605504587156,
//           "gt_score_details": {
//             "pool": 87.5,
//             "transaction": 0,
//             "creation": 100,
//             "info": 100,
//             "holders": 100
//           },
//           "discord_url": null,
//           "farcaster_url": null,
//           "zora_url": null,
//           "telegram_handle": null,
//           "twitter_handle": null,
//           "categories": [],
//           "gt_categories_id": [],
//           "holders": {
//             "count": 1385496,
//             "distribution_percentage": {
//               "top_10": "55.1184",
//               "11_30": "13.5825",
//               "31_50": "4.7971",
//               "rest": "26.502"
//             },
//             "last_updated": "2025-03-12T13:07:47Z"
//           },
//           "mint_authority": null,
//           "freeze_authority": null,
//           "is_honeypot": false
//         }
//       },
//       {
//         "id": "eth_0xdac17f958d2ee523a2206206994597c13d831ec7",
//         "type": "token",
//         "attributes": {
//           "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
//           "name": "Tether USD",
//           "symbol": "USDT",
//           "image_url": "https://assets.coingecko.com/coins/images/325/small/Tether.png?1696501661",
//           "coingecko_coin_id": "tether",
//           "websites": [
//             "https://tether.to/"
//           ],
//           "description": "Tether (USDT) is a cryptocurrency with a value meant to mirror the value of the U.S. dollar. ...",
//           "gt_score": 92.6605504587156,
//           "gt_score_details": {
//             "pool": 87.5,
//             "transaction": 0,
//             "creation": 100,
//             "info": 100,
//             "holders": 0
//           },
//           "discord_url": null,
//           "farcaster_url": null,
//           "zora_url": null,
//           "telegram_handle": null,
//           "twitter_handle": "Tether_to",
//           "categories": [],
//           "gt_categories_id": [],
//           "holders": {
//             "count": 7041203,
//             "distribution_percentage": {
//               "top_10": "45.5782",
//               "11_30": "13.4293",
//               "31_50": "3.9681",
//               "rest": "37.0244"
//             },
//             "last_updated": "2025-03-12T05:28:50Z"
//           },
//           "mint_authority": null,
//           "freeze_authority": null,
//           "is_honeypot": false
//         }
//       }
//     ],
//     "included": [
//       {
//         "id": "eth_0x06da0fd433c1a5d7a4faa01111c044910a184553",
//         "type": "pool",
//         "attributes": {
//           "base_token_address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
//           "quote_token_address": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
//           "sentiment_vote_positive_percentage": 0,
//           "sentiment_vote_negative_percentage": 0,
//           "community_sus_report": 0
//         }
//       }
//     ]
//   }


// const url = `https://api.coingecko.com/api/v3/coins/id/contract/${address}/market_chart?vs_currency=usd&days=${days}&interval=daily`, options)

//Production API Call
export async function getHistoricalData(
  address: string,
  days: number,
) {
  const headers = {
    'accept': 'application/json',
    'x-cg-pro-api-key': `${CG_API_KEY}`
  };
  const options = { method: 'GET', headers: headers };

  try {
    // Asset platform id (e.g. base, ethereum), not the literal path segment "id".
    const assetPlatformId = "robinhood";
    const response = await fetch(
      `https://pro-api.coingecko.com/api/v3/coins/${assetPlatformId}/contract/${encodeURIComponent(address.trim().toLowerCase())}/market_chart?vs_currency=usd&days=${days}&interval=daily`,
      options
    );
    if (!response.ok) {
      throw new Error(`Error fetching historical data: ${response.statusText}`);
    }
    const result = await response.json();
    return result;
  } catch (err) {
    console.error(err);
    return null;
  }
}