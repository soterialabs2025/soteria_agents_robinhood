# CoinGecko Action Provider - Usage Guide

The CoinGecko action provider gives Demeter the ability to fetch token prices by contract address. Here are all the ways you can interact with it.

## Available Actions

1. **`coingecko_getTokenPrice`** - Get price for a single token
2. **`coingecko_getMultipleTokenPrices`** - Get prices for multiple tokens at once

## Method 1: Through the Web Chat Interface (Recommended)

### Setup
1. Start the Next.js development server:
   ```bash
   npm run dev
   ```
2. Open [http://localhost:3000](http://localhost:3000) in your browser
3. Make sure your `.env` file has:
   ```bash
   COIN_GECKO_API_KEY=your-api-key-here
   ```

### Example Queries

**Single Token Price:**
```
What's the current price of TERMS?
Get me the price of 0x1bc0c42215582d5a085795f4badbac3ff36d1bcb
What's WETH trading at in ETH?
```

**Multiple Token Prices:**
```
Get me the prices of TERMS and WETH
Compare TERMS and WETH prices
What are the current prices for 0x1bc0c42215582d5a085795f4badbac3ff36d1bcb and 0x4200000000000000000000000000000000000006?
```

**Specific Currency:**
```
What's TERMS price in ETH?
Get TERMS price in USD
```

The agent will automatically:
- Recognize your request
- Call the appropriate CoinGecko action
- Return formatted price data

## Method 2: Through the API Endpoint

### Direct API Call

```typescript
// Example: Using fetch
const response = await fetch("/api/agent", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    userMessage: "What's the current price of TERMS token at 0x1bc0c42215582d5a085795f4badbac3ff36d1bcb?"
  }),
});

const data = await response.json();
console.log(data.response);
```

### Using cURL

```bash
curl -X POST http://localhost:3000/api/agent \
  -H "Content-Type: application/json" \
  -d '{"userMessage": "Get me the price of TERMS token"}'
```

## Method 3: Programmatically Through AgentKit

If you want to use the action provider directly in your code:

```typescript
import { prepareAgentkitAndWalletProvider } from "./app/api/agent/prepare-agentkit";

async function getTokenPrice() {
  const { agentkit } = await prepareAgentkitAndWalletProvider();
  
  // Get the action from agentkit
  const action = agentkit.getAction("coingecko_getTokenPrice");
  
  if (action) {
    const result = await action.invoke(
      walletProvider, // You'll need the walletProvider too
      {
        contractAddress: "0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
        network: "base",
        vsCurrency: "usd"
      }
    );
    
    console.log(JSON.parse(result));
  }
}
```

## Method 4: Direct Function Calls (For Testing)

You can also import and test the functions directly by modifying the file temporarily:

```typescript
// In coingecko-action-provider.ts, temporarily export the functions:
export async function getTokenPrice(
  contractAddress: string,
  network: string = "base",
  vsCurrency: string = "usd"
): Promise<number> {
  // ... existing code
}

// Then in a test file:
import { getTokenPrice } from "./app/action-providers/coingecko-action-provider";

async function test() {
  const price = await getTokenPrice(
    "0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
    "base",
    "usd"
  );
  console.log("TERMS price:", price);
}
```

## Action Parameters

### `coingecko_getTokenPrice`

- **`contractAddress`** (required): The token contract address
  - Example: `"0x1bc0c42215582d5a085795f4badbac3ff36d1bcb"`
- **`network`** (optional, default: `"base"`): Blockchain network
  - Options: `"base"`, `"ethereum"`, `"arbitrum"`, `"optimism"`, `"polygon"`
- **`vsCurrency`** (optional, default: `"usd"`): Currency to get price in
  - Options: `"usd"`, `"eth"`, `"btc"`, etc.

### `coingecko_getMultipleTokenPrices`

- **`contractAddresses`** (required): Array of token contract addresses
  - Example: `["0x1bc0c42215582d5a085795f4badbac3ff36d1bcb", "0x4200000000000000000000000000000000000006"]`
- **`network`** (optional, default: `"base"`): Blockchain network
- **`vsCurrency`** (optional, default: `"usd"`): Currency to get prices in

## Response Format

### Success Response
```json
{
  "success": true,
  "data": {
    "contractAddress": "0x1bc0c42215582d5a085795f4badbac3ff36d1bcb",
    "network": "base",
    "vsCurrency": "usd",
    "price": 0.12345,
    "timestamp": "2024-01-15T10:30:00.000Z"
  }
}
```

### Error Response
```json
{
  "success": false,
  "error": "Price not found for contract 0x... on base in usd"
}
```

## Common Token Addresses (Base Network)


- **WETH**: `0x4200000000000000000000000000000000000006`


## Troubleshooting

### Error: "COIN_GECKO_API_KEY is required"
- Make sure `COIN_GECKO_API_KEY` is set in your `.env` file
- Restart your development server after adding the key

### Error: "Price not found for contract..."
- Verify the contract address is correct
- Check that the token exists on the specified network
- Ensure the token is listed on CoinGecko for that network

### Error: "CoinGecko API error: 429"
- You've hit the rate limit
- Wait a moment and try again
- Consider upgrading your CoinGecko API plan

## Integration with Demeter Agent

The agent automatically uses CoinGecko actions when:
- You ask about token prices
- The agent needs price data for decision-making
- Comparing multiple token prices
- Making trading or position management decisions

The agent's system prompt instructs it to use CoinGecko for price information, so it will automatically call these actions when relevant.

