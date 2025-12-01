const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

const app = express();

// --- CORS CONFIGURATION (UPDATED) ---
// We restrict access so ONLY your specific website can talk to this server.
app.use(cors({
    origin: 'https://www.alonisthe.dev', // The domain ONLY (no /asdfmarket path needed here)
    methods: ['GET', 'POST']
}));

app.use(express.json());

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
const HOUSE_ADDRESS = "H3tY5a5n7C5h2jK8n3m4n5b6v7c8x9z1a2s3d4f5g6h"; 
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";

// --- STATE ---
let gameState = {
    price: 0,
    priceChange: 0,
    lastUpdated: Date.now(),
    bets: [] 
};

// --- WORKER: PRICE ORACLE ---
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
            params: {
                ids: 'solana',
                vs_currencies: 'usd',
                include_24hr_change: 'true',
                x_cg_demo_api_key: COINGECKO_API_KEY 
            }
        });
        
        if (response.data.solana) {
            gameState.price = response.data.solana.usd;
            gameState.priceChange = response.data.solana.usd_24h_change;
            gameState.lastUpdated = Date.now();
            console.log(`🔥 ORACLE: Price Updated: $${gameState.price}`);
        }
    } catch (e) {
        if (e.response) {
            console.error(`Oracle Error: Code ${e.response.status} - ${e.response.statusText}`);
        } else {
            console.error("Oracle Error: ", e.message);
        }
    }
}

// Fetch every 30 seconds
setInterval(updatePrice, 30000); 
updatePrice(); 

// --- API ENDPOINTS ---

app.get('/api/state', (req, res) => {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    const msUntilClose = midnight - now;

    res.json({
        price: gameState.price,
        change: gameState.priceChange,
        msUntilClose: msUntilClose,
        totalBets: gameState.bets.length
    });
});

app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;

    if (!signature || !userPubKey) return res.status(400).json({ error: "Missing data" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        
        const tx = await connection.getParsedTransaction(signature, { 
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0 
        });

        if (!tx) {
            return res.status(404).json({ error: "Transaction not found on chain yet." });
        }

        if (tx.meta.err) return res.status(400).json({ error: "Transaction failed on chain" });

        gameState.bets.push({
            signature,
            user: userPubKey,
            direction,
            timestamp: Date.now()
        });

        console.log(`✅ BET VERIFIED: ${userPubKey} bet ${direction}`);
        res.json({ success: true, message: "Bet recorded in backend" });

    } catch (e) {
        console.error("Verification failed", e);
        res.status(500).json({ error: "Server verification failed" });
    }
});

app.listen(PORT, () => {
    console.log(`🔥 ASDForecast Server running on port ${PORT}`);
});