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
const PRICE_SCALE = 0.1;

// --- FILE PATHS ---
const STORAGE_FILE = path.join(__dirname, 'storage.json'); // Current Game State
const HISTORY_FILE = path.join(__dirname, 'history.json'); // Past Frames
const USERS_FILE = path.join(__dirname, 'users.json');     // User Stats

// --- STATE MANAGEMENT ---
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    bets: [], // Active bets for current frame
    poolShares: { up: 100, down: 100 } 
};

let frameHistory = []; // Array of past frames
let userStats = {};    // Map of PubKey -> Stats

// --- LOAD DATA ---
function loadData() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const data = JSON.parse(fs.readFileSync(STORAGE_FILE));
            gameState = { ...gameState, ...data };
        }
        if (fs.existsSync(HISTORY_FILE)) {
            frameHistory = JSON.parse(fs.readFileSync(HISTORY_FILE));
        }
        if (fs.existsSync(USERS_FILE)) {
            userStats = JSON.parse(fs.readFileSync(USERS_FILE));
        }
        console.log(`> [SYS] Data Loaded. History: ${frameHistory.length} frames. Users: ${Object.keys(userStats).length}.`);
    } catch (e) { console.error("Load Error", e); }
}

function saveData() {
    try {
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(gameState));
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(frameHistory));
        fs.writeFileSync(USERS_FILE, JSON.stringify(userStats));
    } catch (e) { console.error("Save Error", e); }
}

loadData();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

// --- FRAME CLOSING LOGIC ---
function closeFrame(closePrice, closeTime) {
    console.log(`> [SYS] Closing Frame: ${new Date(gameState.candleStartTime).toISOString()}`);

    // 1. Determine Result
    const openPrice = gameState.candleOpen;
    let result = "FLAT";
    if (closePrice > openPrice) result = "UP";
    else if (closePrice < openPrice) result = "DOWN";

    // 2. Calculate Frame Stats
    // Subtract initial 100 virtual shares to get real volume
    const realSharesUp = Math.max(0, gameState.poolShares.up - 100);
    const realSharesDown = Math.max(0, gameState.poolShares.down - 100);
    
    // Calculate Total SOL wagered in this frame
    const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

    // 3. Archive Frame
    const frameRecord = {
        id: gameState.candleStartTime,
        time: new Date(gameState.candleStartTime).toISOString(),
        open: openPrice,
        close: closePrice,
        result: result,
        sharesUp: realSharesUp,
        sharesDown: realSharesDown,
        totalSol: frameSol
    };
    
    // Add to history (Keep last 100)
    frameHistory.unshift(frameRecord); // Add to front
    if (frameHistory.length > 100) frameHistory.pop();

    // 4. Update User Stats
    // Group bets by user to determine their net position for this frame
    const frameUserPositions = {}; 

    gameState.bets.forEach(bet => {
        if (!frameUserPositions[bet.user]) {
            frameUserPositions[bet.user] = { upShares: 0, downShares: 0, solWagered: 0 };
        }
        if (bet.direction === 'UP') frameUserPositions[bet.user].upShares += bet.shares;
        else frameUserPositions[bet.user].downShares += bet.shares;
        
        frameUserPositions[bet.user].solWagered += bet.costSol;
    });

    // Process outcomes
    for (const [pubKey, pos] of Object.entries(frameUserPositions)) {
        if (!userStats[pubKey]) {
            userStats[pubKey] = { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0 };
        }

        const user = userStats[pubKey];
        user.totalSol += pos.solWagered;
        user.framesPlayed += 1;

        // Win Logic: Majority Shares
        let userDirection = "FLAT";
        if (pos.upShares > pos.downShares) userDirection = "UP";
        else if (pos.downShares > pos.upShares) userDirection = "DOWN";

        if (userDirection !== "FLAT" && result !== "FLAT") {
            if (userDirection === result) {
                user.wins += 1;
                console.log(`> [WIN] User ${pubKey.slice(0,6)} won (Bet ${userDirection}, Result ${result})`);
            } else {
                user.losses += 1;
            }
        }
    }

    // 5. Reset Game State for New Frame
    gameState.candleStartTime = closeTime;
    gameState.candleOpen = closePrice;
    gameState.poolShares = { up: 100, down: 100 }; // Reset Liquidity
    gameState.bets = []; // Clear bets

    saveData();
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
            
            // DETECT FRAME CHANGE
            if (currentWindowStart > gameState.candleStartTime) {
                if (gameState.candleStartTime !== 0) {
                    // Close the previous frame using the new price as the "Close"
                    closeFrame(currentPrice, currentWindowStart);
                } else {
                    // First run init
                    gameState.candleStartTime = currentWindowStart;
                    gameState.candleOpen = currentPrice;
                    saveData();
                }
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

    // Pricing
    const totalShares = gameState.poolShares.up + gameState.poolShares.down;
    const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
    const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;

    // Get specific user stats if requested
    const userKey = req.query.user;
    let myStats = null;
    if (userKey && userStats[userKey]) {
        myStats = userStats[userKey];
    }

    res.json({
        price: gameState.price,
        openPrice: gameState.candleOpen,
        change: percentChange,
        msUntilClose: msUntilClose,
        market: {
            priceUp, priceDown,
            sharesUp: gameState.poolShares.up,
            sharesDown: gameState.poolShares.down
        },
        history: frameHistory.slice(0, 3), // Send last 3 frames
        userStats: myStats
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

        // Extract SOL
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

        if (lamports === 0) return res.status(400).json({ error: "NO_FUNDS" });
        const solAmount = lamports / 1000000000;

        // Calc Shares
        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; 
        if (direction === 'UP') price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        else price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;

        // Update Pool
        if (direction === 'UP') gameState.poolShares.up += sharesReceived;
        else gameState.poolShares.down += sharesReceived;

        // Initialize User if new (so we track them immediately)
        if (!userStats[userPubKey]) {
            userStats[userPubKey] = { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0 };
        }

        gameState.bets.push({
            signature, user: userPubKey, direction,
            costSol: solAmount, entryPrice: price, shares: sharesReceived,
            timestamp: Date.now()
        });

        saveData();
        
        console.log(`> TRADE: ${userPubKey} | ${direction} | ${sharesReceived.toFixed(2)} Shares`);
        res.json({ success: true, shares: sharesReceived, price: price });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Engine v2 running on ${PORT}`);
});
