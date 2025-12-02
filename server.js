const express = require('express');
const cors = require('cors');
const { Connection, PublicKey, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } = require('@solana/web3.js');
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
const FEE_WALLET = new PublicKey("5xfyqaDzaj1XNvyz3gnuRJMSNUzGkkMbYbh2bKzWxuan");
const COINGECKO_API_KEY = "CG-KsYLbF8hxVytbPTNyLXe7vWA";
const PRICE_SCALE = 0.1; 
const PAYOUT_MULTIPLIER = 0.94; // 94% of the Unit Value (0.1)
const FEE_PERCENT = 0.0552; // 5.52% of Total Volume
const RESERVE_SOL = 0.02; // Minimum to keep in wallet

// --- PERSISTENCE CONFIGURATION ---
const RENDER_DISK_PATH = '/var/data';
const DATA_DIR = fs.existsSync(RENDER_DISK_PATH) ? RENDER_DISK_PATH : path.join(__dirname, 'data');
const FRAMES_DIR = path.join(DATA_DIR, 'frames');
const USERS_DIR = path.join(DATA_DIR, 'users');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
if (!fs.existsSync(FRAMES_DIR)) fs.mkdirSync(FRAMES_DIR);
if (!fs.existsSync(USERS_DIR)) fs.mkdirSync(USERS_DIR);

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

console.log(`> [SYS] Persistence Root: ${DATA_DIR}`);

// --- KEY MANAGEMENT (SECURE) ---
let houseKeypair;
try {
    // 1. Try Environment Variable (Production Best Practice)
    if (process.env.SOLANA_WALLET_JSON) {
        const secret = Uint8Array.from(JSON.parse(process.env.SOLANA_WALLET_JSON));
        houseKeypair = Keypair.fromSecretKey(secret);
        console.log(`> [AUTH] Loaded Wallet from ENV: ${houseKeypair.publicKey.toString()}`);
    } 
    // 2. Try Local File (Dev Fallback)
    else if (fs.existsSync('house-wallet.json')) {
        const secret = Uint8Array.from(JSON.parse(fs.readFileSync('house-wallet.json')));
        houseKeypair = Keypair.fromSecretKey(secret);
        console.log(`> [AUTH] Loaded Wallet from File: ${houseKeypair.publicKey.toString()}`);
    } else {
        console.warn("> [WARN] NO PRIVATE KEY FOUND. PAYOUTS WILL FAIL.");
    }
} catch (e) {
    console.error("> [ERR] Wallet Load Failed:", e.message);
}

// --- STATE ---
let gameState = {
    price: 0,
    candleOpen: 0,
    candleStartTime: 0,
    poolShares: { up: 100, down: 100 },
    bets: [] 
};
let historySummary = [];

// --- I/O ---
function loadGlobalState() {
    try {
        if (fs.existsSync(HISTORY_FILE)) historySummary = JSON.parse(fs.readFileSync(HISTORY_FILE));
        if (fs.existsSync(STATE_FILE)) {
            const savedState = JSON.parse(fs.readFileSync(STATE_FILE));
            gameState.candleOpen = savedState.candleOpen || 0;
            gameState.candleStartTime = savedState.candleStartTime || 0;
            gameState.poolShares = savedState.poolShares || { up: 100, down: 100 };
            
            const currentFrameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            if (fs.existsSync(currentFrameFile)) {
                const frameData = JSON.parse(fs.readFileSync(currentFrameFile));
                gameState.bets = frameData.bets || [];
                gameState.poolShares = frameData.poolShares || gameState.poolShares;
            } else {
                gameState.bets = [];
            }
        }
    } catch (e) { console.error("> [ERR] Load Error:", e); }
}

function saveSystemState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            candleOpen: gameState.candleOpen,
            candleStartTime: gameState.candleStartTime,
            poolShares: gameState.poolShares
        }));

        if (gameState.candleStartTime > 0) {
            const frameFile = path.join(FRAMES_DIR, `frame_${gameState.candleStartTime}.json`);
            fs.writeFileSync(frameFile, JSON.stringify({
                id: gameState.candleStartTime,
                open: gameState.candleOpen,
                poolShares: gameState.poolShares,
                bets: gameState.bets
            }));
        }
    } catch (e) { console.error("> [ERR] Save Error:", e); }
}

function getUser(pubKey) {
    const file = path.join(USERS_DIR, `user_${pubKey}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
    return { wins: 0, losses: 0, totalSol: 0, framesPlayed: 0 };
}

function saveUser(pubKey, data) {
    fs.writeFileSync(path.join(USERS_DIR, `user_${pubKey}.json`), JSON.stringify(data));
}

loadGlobalState();

// --- 15m LOGIC ---
function getCurrentWindowStart() {
    const now = new Date();
    const minutes = Math.floor(now.getMinutes() / 15) * 15;
    const start = new Date(now);
    start.setMinutes(minutes, 0, 0, 0);
    return start.getTime();
}

// --- PAYOUT ENGINE ---
async function processPayouts(result, bets, totalVolume) {
    if (!houseKeypair) return console.log("> [PAYOUT] No Private Key. Skipping.");
    if (totalVolume === 0) return console.log("> [PAYOUT] No Volume. Skipping.");

    const connection = new Connection(SOLANA_NETWORK, 'confirmed');
    console.log(`> [PAYOUT] Processing... Result: ${result} | Vol: ${totalVolume} SOL`);

    try {
        // 1. Check Reserve
        const balance = await connection.getBalance(houseKeypair.publicKey);
        const balanceSol = balance / 1e9;
        
        if (balanceSol < RESERVE_SOL) {
            console.error(`> [PAYOUT] CRITICAL: Wallet below reserve (${balanceSol} < ${RESERVE_SOL}). Halting payouts.`);
            return;
        }

        // 2. Pay Fee Wallet
        const feeLamports = Math.floor((totalVolume * FEE_PERCENT) * 1e9);
        if (feeLamports > 0) {
            try {
                const feeTx = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: houseKeypair.publicKey,
                        toPubkey: FEE_WALLET,
                        lamports: feeLamports
                    })
                );
                await sendAndConfirmTransaction(connection, feeTx, [houseKeypair]);
                console.log(`> [PAYOUT] Fee Sent: ${(feeLamports/1e9).toFixed(4)} SOL`);
            } catch (e) {
                console.error(`> [PAYOUT] Fee Payment Failed: ${e.message}`);
            }
        }

        // 3. Identify Winners & Pay
        // Group bets by user first to batch payments (1 tx per winner)
        const userPositions = {};
        bets.forEach(bet => {
            if (!userPositions[bet.user]) userPositions[bet.user] = { up: 0, down: 0 };
            if (bet.direction === 'UP') userPositions[bet.user].up += bet.shares;
            else userPositions[bet.user].down += bet.shares;
        });

        for (const [pubKey, pos] of Object.entries(userPositions)) {
            let userDirection = "FLAT";
            if (pos.up > pos.down) userDirection = "UP";
            else if (pos.down > pos.up) userDirection = "DOWN";

            // Only pay if they Won
            if (userDirection === result && result !== "FLAT") {
                const winningShares = result === "UP" ? pos.up : pos.down;
                
                // MATH: Shares * 0.94 * SCALE(0.1)
                const payoutSol = winningShares * PAYOUT_MULTIPLIER * PRICE_SCALE;
                const payoutLamports = Math.floor(payoutSol * 1e9);

                if (payoutLamports > 0) {
                    try {
                        const tx = new Transaction().add(
                            SystemProgram.transfer({
                                fromPubkey: houseKeypair.publicKey,
                                toPubkey: new PublicKey(pubKey),
                                lamports: payoutLamports
                            })
                        );
                        // In production, consider queuing these or using a delay to avoid rate limits
                        await sendAndConfirmTransaction(connection, tx, [houseKeypair]);
                        console.log(`> [PAYOUT] Sent ${payoutSol.toFixed(4)} SOL to ${pubKey.slice(0,6)}...`);
                    } catch (e) {
                        console.error(`> [PAYOUT] User Payout Failed (${pubKey}): ${e.message}`);
                    }
                }
            }
        }

    } catch (e) {
        console.error("> [PAYOUT] System Error:", e);
    }
}

function closeFrame(closePrice, closeTime) {
    console.log(`> [SYS] Closing Frame: ${gameState.candleStartTime}`);

    const openPrice = gameState.candleOpen;
    let result = "FLAT";
    if (closePrice > openPrice) result = "UP";
    else if (closePrice < openPrice) result = "DOWN";

    const realSharesUp = Math.max(0, gameState.poolShares.up - 100);
    const realSharesDown = Math.max(0, gameState.poolShares.down - 100);
    
    // Calculate total SOL in this frame for Fee calculation
    const frameSol = gameState.bets.reduce((acc, bet) => acc + bet.costSol, 0);

    // Archive
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
    
    historySummary.unshift(frameRecord); 
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historySummary));

    // Update User Stats
    const usersInFrame = {};
    gameState.bets.forEach(bet => {
        if (!usersInFrame[bet.user]) usersInFrame[bet.user] = { up: 0, down: 0 };
        if (bet.direction === 'UP') usersInFrame[bet.user].up += bet.shares;
        else usersInFrame[bet.user].down += bet.shares;
    });

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

    // TRIGGER PAYOUTS (Async)
    // We pass a copy of bets so clearing state doesn't affect it
    processPayouts(result, [...gameState.bets], frameSol);

    // Reset State
    gameState.candleStartTime = closeTime;
    gameState.candleOpen = closePrice;
    gameState.poolShares = { up: 100, down: 100 }; 
    gameState.bets = []; 

    saveSystemState(); 
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
        myStats = getUser(userKey);
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
        history: historySummary,
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
        
        // Find transfer to House
        let housePubKeyStr = houseKeypair ? houseKeypair.publicKey.toString() : "BXSp5y6Ua6tB5fZDe1EscVaaEaZLg1yqzrsPqAXhKJYy"; // Fallback to public const if keypair missing locally

        for (let ix of instructions) {
            if (ix.program === 'system' && ix.parsed.type === 'transfer') {
                if (ix.parsed.info.destination === housePubKeyStr) {
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

        const userData = getUser(userPubKey);
        userData.totalSol += solAmount;
        saveUser(userPubKey, userData);

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
    console.log(`> ASDForecast Engine v13 (Payouts Enabled) running on ${PORT}`);
    if (houseKeypair) console.log("> [AUTH] House Keypair is Active.");
    else console.warn("> [AUTH] WARNING: House Keypair NOT found. Payouts disabled.");
});
