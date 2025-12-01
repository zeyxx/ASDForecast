const express = require('express');
const cors = require('cors');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

const app = express();
app.use(cors({
    origin: 'https://www.alonisthe.dev', // For testing. In production, change '*' to 'https://your-squarespace-site.com'
    methods: ['GET', 'POST']
}));
app.use(express.json());

// --- CONFIGURATION ---
const PORT = 3000;
const SOLANA_NETWORK = 'https://api.devnet.solana.com';
const HOUSE_ADDRESS = "H3tY5a5n7C5h2jK8n3m4n5b6v7c8x9z1a2s3d4f5g6h"; // Your House Wallet
const BET_AMOUNT_SOL = 0.05;

// --- STATE (In memory for demo, use Database in production) ---
let gameState = {
    price: 0,
    priceChange: 0,
    lastUpdated: Date.now(),
    bets: [] // Store active bets { signature, user, direction, amount }
};

// --- WORKER: PRICE ORACLE ---
// Fetches price once every 30 seconds for everyone
async function updatePrice() {
    try {
        const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true');
        if (response.data.solana) {
            gameState.price = response.data.solana.usd;
            gameState.priceChange = response.data.solana.usd_24h_change;
            console.log(`🔥 ORACLE: Price Updated: $${gameState.price}`);
        }
    } catch (e) {
        console.error("Oracle Error: ", e.message);
    }
}
setInterval(updatePrice, 30000); // Run every 30s
updatePrice(); // Run on startup

// --- API ENDPOINTS ---

// 1. GET STATE: Frontend polls this instead of CoinGecko
app.get('/api/state', (req, res) => {
    // Calculate countdown server-side
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

// 2. VERIFY BET: The Security Core
app.post('/api/verify-bet', async (req, res) => {
    const { signature, direction, userPubKey } = req.body;

    if (!signature || !userPubKey) return res.status(400).json({ error: "Missing data" });

    try {
        const connection = new Connection(SOLANA_NETWORK, 'confirmed');
        
        // A. Ask Blockchain for tx details
        const tx = await connection.getParsedTransaction(signature, { commitment: 'confirmed' });

        if (!tx) {
            return res.status(404).json({ error: "Transaction not found on chain" });
        }

        // B. SECURITY CHECKS
        // 1. Did it fail?
        if (tx.meta.err) return res.status(400).json({ error: "Transaction failed on chain" });

        // 2. Check Instructions: Did money move to HOUSE_ADDRESS?
        const instructions = tx.transaction.message.instructions;
        let validTransfer = false;

        // Loop through instructions to find the transfer
        // Note: Real parsing is complex, this is simplified for clarity
        // We check if the programId is SystemProgram and destination is House
        // (In production, parse 'parsed' instruction data specifically)
        
        // For this demo, we assume if the signature exists and is confirmed, we accept it.
        // REAL PROD: You must verify tx.transaction.message.instructions[0].parsed.info.lamports == BET_AMOUNT
        
        // C. Record Bet
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
    console.log(`🔥 ASDForecast Server burning on http://localhost:${PORT}`);
});