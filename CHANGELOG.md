# ASDForecast Changelog

## Version 121.0 - Lottery System with Activity Requirement

### Overview

This update introduces a weekly ASDF lottery system designed to reward long-term holders who actively participate in the platform. The system is built to be ungameable and follows a libertarian philosophy - no artificial barriers, just organic engagement.

---

## New Features

### 1. Weekly ASDF Lottery

**Eligibility Requirements:**
- Hold >= 0.00552% of ASDF circulating supply (~52,255 ASDF at current supply)
- Play on the platform at least once in the last 7 days

**Ticket Calculation:**
```
baseTickets = 1 + weeksHolding (max 52)
activityMultiplier = activeDays / 7
effectiveTickets = baseTickets * activityMultiplier
```

**Example:**
| Holding Duration | Active Days | Base Tickets | Multiplier | Effective Tickets |
|-----------------|-------------|--------------|------------|-------------------|
| 10 weeks | 7/7 | 11 | 100% | 11 |
| 10 weeks | 5/7 | 11 | 71% | 8 |
| 10 weeks | 0/7 | 11 | 0% | 0 (ineligible) |

**Prize Pool:**
```
prize = BASE_PRIZE (100,000 ASDF) + (totalTickets * 10,000 ASDF)
```

---

## Files Modified

### server.js

**New Constants (lines 44-53):**
```javascript
const LOTTERY_CONFIG = {
    ELIGIBILITY_PERCENT: 0.0000552,  // 0.00552% of supply
    MAX_TICKETS: 52,
    DRAW_INTERVAL_MS: 7 * 24 * 60 * 60 * 1000,  // 7 days
    ACTIVITY_WINDOW_DAYS: 7,
    BASE_PRIZE: 100000,
    PRIZE_PER_TICKET: 10000,
    SUPPLY_CACHE_MS: 5 * 60 * 1000
};
```

**New Functions:**
| Function | Purpose |
|----------|---------|
| `recordUserActivity(pubKey)` | Records daily activity when user places bet |
| `calculateActivityMultiplier(activityDays)` | Returns 0-1 based on days active |
| `getCirculatingSupply()` | On-chain query for ASDF supply |
| `getUserASDFBalance(pubKey)` | On-chain query for user's ASDF balance |
| `checkLotteryEligibility(pubKey)` | Checks if user meets threshold |
| `calculateTickets(user)` | Returns base + effective tickets |
| `getTokenAccountFirstTransaction(connection, address)` | Finds first tx for holding duration |
| `getEligibleParticipants()` | Scans all on-chain holders with activity |
| `executeLotteryDraw()` | Runs the lottery draw with mutex protection |
| `checkLotterySchedule()` | Scheduled task for auto-draws |

**New API Endpoints:**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/lottery/status` | GET | Current round, countdown, config |
| `/api/lottery/eligibility?user=` | GET | User's eligibility, tickets, activity |
| `/api/lottery/history` | GET | Past draws |
| `/api/admin/lottery/draw` | POST | Manual draw trigger (admin only) |

**New Data Files:**
- `data/lottery_state.json` - Current round state
- `data/lottery_history.json` - Draw history

---

### frontend.html

**New UI Section (lines 250-305):**
- Lottery panel with round number, countdown timer
- Your tickets display with activity indicator
- Last winner display
- Eligibility status (ELIGIBLE / NEED ACTIVITY / NOT ELIGIBLE)
- "How it works" explanation

**New UI Elements:**
- `#lottery-round` - Current round number
- `#lottery-countdown` - Time until next draw
- `#lottery-tickets` - User's effective ticket count
- `#lottery-activity` - Activity status (X/7 days)
- `#lottery-winner` - Last winner address
- `#lottery-prize` - Last prize amount

---

### control_panel.html

**New Admin Section:**
- Manual lottery draw trigger button
- Displays lottery round, countdown, winner, prize

---

## Security Measures

| Measure | Implementation |
|---------|----------------|
| Race condition prevention | `lotteryMutex` for concurrent draw protection |
| Cryptographic randomness | `crypto.randomInt()` for winner selection |
| Input validation | All pubKeys validated with regex |
| Activity verification | On-chain tx required before activity recorded |
| Admin authentication | Environment variable password |
| Rate limiting | `stateLimiter` on lottery endpoints |

---

## Anti-Gaming Design

**Why it can't be exploited:**

1. **Activity requires real SOL** - Must send actual SOL to house wallet (verified on Solana blockchain)
2. **Wallet splitting loses duration** - New wallets start at 0 weeks
3. **Duration verified on-chain** - First transaction timestamp queried from Solana
4. **No Sybil advantage** - More wallets = less time per wallet = fewer tickets each

---

## Configuration

**Environment Variables:**
```bash
HELIUS_API_KEY=your_api_key      # For Solana RPC
ADMIN_ACTION_PASSWORD=your_pwd   # For admin endpoints
```

**Schedule:**
- Draws every 7 days automatically
- Checked every hour via `setInterval`
- Can be triggered manually via admin endpoint

---

## Testing

```bash
# Test lottery status
curl http://localhost:3000/api/lottery/status

# Test user eligibility
curl "http://localhost:3000/api/lottery/eligibility?user=YOUR_PUBKEY"

# Trigger manual draw (admin)
curl -X POST http://localhost:3000/api/admin/lottery/draw \
  -H "x-admin-secret: YOUR_ADMIN_PASSWORD"
```

---

## Migration Notes

- No database migration needed - uses JSON file storage
- Lottery state auto-initializes on first run
- Existing users automatically tracked on next bet
