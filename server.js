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
const HOUSE_ADDRESS = "BXSp5y6Ua6tB5fZDe1EscVaaEaZLg1yqzrsPqAXhKJYy";
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const PRICE_SCALE = 0.1;

// --- PERSISTENCE DIRECTORIES ---
const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fs.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const USERS_DIR = path.join(DATA_DIR, 'users');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR);
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR);

const STATE_FILE = path.join(DATA_DIR, 'state.json');     // Global pointers (current candle time)
const HISTORY_FILE = path.join(DATA_DIR, 'history.json'); // Lightweight summary of past results

console.log(`> [SYS] Persistence Sharding Active. Root: ${DATA_DIR}`);

// --- MEMORY CACHE ---
// We keep the CURRENT frame in memory for speed, flush to specific file on changes.
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    poolShares: { up: 100, down: 100 },
    bets: [] // Current frame bets only
};

let historySummary = []; // List of past frame results (lightweight)

// --- I/O HELPERS ---

function loadGlobalState() {
    try {
        // 1. Load History Summary
        if (fs.existsSync(HISTORY_FILE)) {
            historySummary = JSON.parse(fs.readFileSync(HISTORY_FILE));
        }

        // 2. Load Global State Pointers
        if (fs.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fs.readFileSync(STATE_FILE));
            gameState.candleOpen = savedState.candleOpen || 0;
            gameState.candleStartTime = savedState.candleStartTime || 0;
            gameState.poolShares = savedState.poolShares || { up: 100, down: 100 };
            
            // 3. Load Active Frame Data
            // We construct the filename based on the saved start time
            const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            if (fs.existsSync(currentFrameFile)) {
                const frameData = JSON.parse(fs.readFileSync(currentFrameFile));
                gameState.bets = frameData.bets || [];
                // Sync pool shares just in case
                gameState.poolShares = frameData.poolShares || gameState.poolShares;
            } else {
                gameState.bets = [];
            }
        }
    } catch (e) { console.error("> [ERR] Load Error:", e); }
}

// Save global pointers + Current Frame detailed file
function saveSystemState() {
    try {
        // 1. Save Pointers
        const pointers = {
            candleOpen: gameState.candleOpen,
            candleStartTime: gameState.candleStartTime,
            poolShares: gameState.poolShares
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(pointers));

        // 2. Save Current Frame Detail
        if (gameState.candleStartTime > 0) {
            const frameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            const frameData = {
                id: gameState.candleStartTime,
                open: gameState.candleOpen,
                poolShares: gameState.poolShares,
                bets: gameState.bets
            };
            fs.writeFileSync(frameFile, JSON.stringify(frameData));
        }
    } catch (e) { console.error("> [ERR] Save Error:", e); }
}

// User File I/O (Read/Write specific user)
function getUser(pubKey) {
    const file = path.join(USERS_DIR, `user_${pubKey}.json`);
    if (fs.existsSync(file)) {
        return JSON.parse(fs.readFileSync(file));
    }
    return { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0 };
}

function saveUser(pubKey, data) {
    const file = path.join(USERS_DIR, `user_${pubKey}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
}

// Initial Load
loadGlobalState();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

function closeFrame(closePrice, closeTime) {
    console.log(`> [SYS] Closing Frame: ${gameState.candleStartTime}`);

    const openPrice = gameState.candleOpen;
    let result = "FLAT";
    if (closePrice > openPrice) result = "UP";
    else if (closePrice < openPrice) result = "DOWN";

    const realSharesUp = Math.max(0, gameState.poolShares.up - 100);
    const realSharesDown = Math.max(0, gameState.poolShares.down - 100);
    const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

    // 1. Archive Summary to History
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
    
    // Add to history (Infinite)
    historySummary.unshift(frameRecord); 
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historySummary));

    // 2. Process Winners (Batch User Updates)
    // We group bets by user to minimize file I/O (read user once, update, save once)
    const usersInFrame = {};

    gameState.bets.forEach(bet => {
        if (!usersInFrame[bet.user]) {
            usersInFrame[bet.user] = { up: 0, down: 0 };
        }
        if (bet.direction === 'UP') usersInFrame[bet.user].up += bet.shares;
        else usersInFrame[bet.user].down += bet.shares;
    });

    // Update each user file
    for (const [pubKey, pos] of Object.entries(usersInFrame)) {
        const userData = getUser(pubKey);
        userData.framesPlayed += 1;

        let userDir = "FLAT";
        if (pos.up > pos.down) userDir = "UP";
        else if (pos.down > pos.up) userDir = "DOWN";

        if (userDir !== "FLAT" && result !== "FLAT") {
            if (userDir === result) userData.wins += 1;
            else userData.losses += 1;
        }
        
        saveUser(pubKey, userData);
    }

    // 3. Reset State for New Frame
    gameState.candleStartTime = closeTime;
    gameState.candleOpen = closePrice;
    gameState.poolShares = { up: 100, down: 100 }; 
    gameState.bets = []; // Clear memory bets

    saveSystemState(); // Create new frame file
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
            
            if (currentWindowStart > gameState.candleStartTime) {
                if (gameState.candleStartTime !== 0) {
                    closeFrame(currentPrice, currentWindowStart);
                } else {
                    // First Run
                    gameState.candleStartTime = currentWindowStart;
                    gameState.candleOpen = currentPrice;
                    saveSystemState();
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

    const totalShares = gameState.poolShares.up + gameState.poolShares.down;
    const priceUp = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
    const priceDown = (gameState.poolShares.down / totalShares) * PRICE_SCALE;

    const userKey = req.query.user;
    let myStats = null;
    let activePosition = null;

    if (userKey) {
        // Load specific user file on demand
        myStats = getUser(userKey);
        
        // Calculate active position from memory
        const userBets = gameState.bets.filter(b => b.user === userKey);
        activePosition = {
            upShares: userBets.filter(b => b.direction === 'UP').reduce((a, b) => a + b.shares, 0),
            downShares: userBets.filter(b => b.direction === 'DOWN').reduce((a, b) => a + b.shares, 0),
            wageredSol: userBets.reduce((a, b) => a + b.costSol, 0)
        };
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
        history: historySummary, // Send the summary list
        userStats: myStats,
        activePosition: activePosition 
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

        const totalShares = gameState.poolShares.up + gameState.poolShares.down;
        let price = 0.05; 
        if (direction === 'UP') price = (gameState.poolShares.up / totalShares) * PRICE_SCALE;
        else price = (gameState.poolShares.down / totalShares) * PRICE_SCALE;
        if(price < 0.001) price = 0.001;

        const sharesReceived = solAmount / price;

        if (direction === 'UP') gameState.poolShares.up += sharesReceived;
        else gameState.poolShares.down += sharesReceived;

        // --- UPDATE INDIVIDUAL USER FILE ---
        const userData = getUser(userPubKey);
        userData.totalSol += solAmount;
        saveUser(userPubKey, userData);

        // --- UPDATE CURRENT FRAME FILE ---
        gameState.bets.push({
            signature, user: userPubKey, direction,
            costSol: solAmount, entryPrice: price, shares: sharesReceived,
            timestamp: Date.now()
        });
        saveSystemState();
        
        console.log(`> TRADE: ${userPubKey} | ${direction} | ${sharesReceived.toFixed(2)} Shares`);
        res.json({ success: true, shares: sharesReceived, price: price });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

app.listen(PORT, () => {
    console.log(`> ASDForecast Engine v6 (Sharded Persistence) running on ${PORT}`);
});
