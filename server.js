const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(cors({
    origin: 'https://www.alonisthe.dev',
    methods: ['GET', 'POST']
}));

app.use(express.json());

const PORT = process.env.PORT || 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
const HOUSE_ADDRESS = "H3tY5a5n7C5h2jK8n3m4n5b6v7c8x9z1a2s3d4f5g6h";
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const STORAGE_FILE = path.join(__dirname, 'storage.json');
const PRICE_SCALE = 0.1; // Sum of prices will equal 0.1 SOL

// --- PERSISTENCE ---
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    bets: [],
    // Start with 100 Shares each (Virtual Liquidity)
    poolShares: { up: 100, down: 100 } 
};

function loadState() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE));
            gameState.bets = data.bets || [];
            gameState.candleOpen = data.candleOpen || 0;
            gameState.candleStartTime = data.candleStartTime || 0;
            gameState.poolShares = data.poolShares || { up: 100, down: 100 };
            console.log(`> [SYS] State loaded.`);
        }
    } catch (e) { console.error("Load Error", e); }
}

function saveState() {
    try {
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(gameState));
    } catch (e) { console.error("Save Error", e); }
}

loadState();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0);
    return start.getTime();
}

// --- ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: { ids: 'solana', vs_currencies: 'usd', x_cg_demo_api_key: COINGECKO_API_KEY }
        });
        
        if (response.data.solana) {
            const currentPrice = response.data.solana.usd;
            gameState.price = currentPrice;
            
            const currentWindowStart = getCurrentWindowStart();
            
            // NEW CANDLE DETECTED
            if (currentWindowStart > gameState.candleStartTime) {
                console.log(`> [SYS] New 15m Candle: ${new Date(currentWindowStart).toISOString()}`);
                gameState.candleStartTime = currentWindowStart;
                gameState.candleOpen = currentPrice;
                
                // RESET POOL TO 100 / 100 SHARES
                gameState.poolShares = { up: 100, down: 100 }; 
                gameState.bets = []; 
                saveState();
            } else if (gameState.candleOpen === 0) {
                gameState.candleOpen = currentPrice;
                gameState.candleStartTime = currentWindowStart;
            }
        }
    } catch (e) { console.log("Oracle unstable"); }
}

setInterval(updatePrice, 30000); 
updatePrice(); 

// --- ENDPOINTS ---

app.get('/api/state', (req, res) => {
    const now = new Date();
    const currentWindowStart = getCurrentWindowStart();
    const nextWindowStart = currentWindowStart + (15 * 60 * 1000);
    const msUntilClose = nextWindowStart - now.getTime();

    const priceChange = gameState.price - gameState.candleOpen;
    const percentChange = gameState.candleOpen ? (priceChange / gameState.candleOpen) * 100 : 0;

    // CALCULATE DYNAMIC PRICES (Scaled by 0.1)
    const totalShares = gameState.poolShares.up + gameState.poolShares.down;
    
    // Price = (Share of Pool) * 0.1
    // Example: 100/200 * 0.1 = 0.5 * 0.1 = 0.05 SOL
    const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
    const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;

    res.json({
        price: gameState.price,
        openPrice: gameState.candleOpen,
        change: percentChange,
        msUntilClose: msUntilClose,
        market: {
            priceUp: priceUp,
            priceDown: priceDown,
            sharesUp: gameState.poolShares.up,
            sharesDown: gameState.poolShares.down
        }
    });
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;

    if (!signature || !userPubKey) return res.status(400).json({ error: "MISSING_DATA" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });

        if (!tx) return res.status(404).json({ error: "TX_NOT_FOUND" });
        if (tx.meta.err) return res.status(400).json({ error: "TX_FAILED" });

        // Extract SOL Amount
        let lamports = 0;
        const instructions = tx.transaction.message.instructions;
        for (let ix of instructions) {
            if (ix.program === 'system' && ix.parsed.type === 'transfer') {
                if (ix.parsed.info.destination === HOUSE_ADDRESS) {
                    lamports = ix.parsed.info.lamports;
                    break;
                }
            }
        }

        if (lamports === 0) return res.status(400).json({ error: "NO_FUNDS_DETECTED" });

        const solAmount = lamports / 1000000000;

        // CALCULATE SHARES PURCHASED
        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; // Default safe price
        
        if (direction === 'UP') {
            price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        } else {
            price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        }

        // Lower safety floor for 0.1 scale
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;

        // Add new shares to the pool
        if (direction === 'UP') {
            gameState.poolShares.up += sharesReceived;
        } else {
            gameState.poolShares.down += sharesReceived;
        }

        gameState.bets.push({
            signature,
            user: userPubKey,
            direction,
            costSol: solAmount,
            entryPrice: price,
            shares: sharesReceived,
            timestamp: Date.now()
        });

        saveState();
        
        console.log(`> TRADE: ${userPubKey} bought ${sharesReceived.toFixed(2)} ${direction} shares for ${solAmount} SOL @ ${price.toFixed(3)}`);
        res.json({ success: true, shares: sharesReceived, price: price });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Market Engine running on ${PORT}`);
});
