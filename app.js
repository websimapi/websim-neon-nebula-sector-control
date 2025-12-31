import { getHexGrid, hexToPixel, getKey, getNeighbors, hexDistance } from './hex_engine.js';

// --- CONFIG ---
const MAX_PLAYERS = 4;
const BOARD_RADIUS = 6;
const STARTING_ENERGY = 3;
const WIN_PCT = 0.8;
const COSTS = {
    DEPLOY: 2,
    FORTIFY: 1,
    OVERLOAD: 3,
    REINFORCE: 4,
    STRIKE: 5
};

const ITEMS = ['energy', 'crystal', 'shockwave'];

// --- TOAST SYSTEM ---
function showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerText = message;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.5s';
        setTimeout(() => el.remove(), 500);
    }, 3000);
}

// --- AUDIO ---
const sfx = {
    deploy: new Audio('sfx_deploy.mp3'),
    overload: new Audio('sfx_overload.mp3'),
    victory: new Audio('sfx_victory.mp3'),
    strike: new Audio('sfx_strike.mp3'),
    powerup: new Audio('sfx_powerup.mp3')
};
const playSound = (name) => {
    sfx[name].currentTime = 0;
    sfx[name].play().catch(e => {}); 
};

// --- DB HELPERS ---
async function getUserData() {
    try {
        const currentUser = await window.websim.getCurrentUser();
        // Use 'user_data_v1' collection
        const records = await room.collection('user_data_v1').filter({ username: currentUser.username }).getList();
        
        if (records.length === 0) {
            return await room.collection('user_data_v1').create({
                username: currentUser.username,
                col_1: { wins: 0, losses: 0, matches_played: 0, elo: 1000 },
                col_2: { history: [] }
            });
        }
        return records[0];
    } catch (e) {
        console.error("DB Error", e);
        return null;
    }
}

async function updateStats(isWinner, matchId) {
    const record = await getUserData();
    if (!record) return;

    const stats = record.col_1 || { wins: 0, losses: 0, matches_played: 0, elo: 1000 };
    const history = record.col_2?.history || [];

    stats.matches_played++;
    if (isWinner) {
        stats.wins++;
        stats.elo += 25;
    } else {
        stats.losses++;
        stats.elo = Math.max(0, stats.elo - 15);
    }

    history.unshift({
        id: matchId,
        result: isWinner ? 'WIN' : 'LOSS',
        date: new Date().toISOString()
    });
    if (history.length > 10) history.pop();

    await room.collection('user_data_v1').update(record.id, {
        col_1: stats,
        col_2: { history }
    });
}

// --- WEBSIM SETUP ---
const room = new WebsimSocket();

function Game() {
    const [status, setStatus] = React.useState('loading');
    const [peers, setPeers] = React.useState({});
    const [roomState, setRoomState] = React.useState({});
    const [presence, setPresence] = React.useState({});
    const [myId, setMyId] = React.useState(null);
    const [action, setAction] = React.useState(null);
    const [userStats, setUserStats] = React.useState(null);
    const [leaderboard, setLeaderboard] = React.useState([]);

    React.useEffect(() => {
        let cleanupRoom;
        let cleanupPresence;

        const init = async () => {
            await room.initialize();
            
            setPeers({ ...room.peers });
            setRoomState(room.roomState);
            setPresence(room.presence);
            setMyId(room.clientId);
            
            // Subscribe to room state
            cleanupRoom = room.subscribeRoomState(setRoomState);
            
            // Subscribe to presence (handles peers joining/leaving)
            cleanupPresence = room.subscribePresence((newPresence) => {
                setPresence(newPresence);
                setPeers({ ...room.peers });
            });

            // Fetch user stats
            const stats = await getUserData();
            setUserStats(stats?.col_1);

            // Fetch Leaderboard
            try {
                const allStats = await room.collection('user_data_v1').getList();
                const sorted = allStats.sort((a,b) => (b.col_1?.elo || 0) - (a.col_1?.elo || 0)).slice(0, 10);
                setLeaderboard(sorted);
            } catch(e) { console.warn("Leaderboard fetch failed", e); }

            // Initial Room State defaults
            if (!room.roomState.phase) {
                // Only host initializes if phase is missing
                if (Object.keys(room.peers)[0] === room.clientId) {
                    room.updateRoomState({
                        phase: 'lobby',
                        players: [],
                        board: {},
                        turnIndex: 0,
                        gameLog: [],
                        turnStartTime: Date.now()
                    });
                }
            }
            
            if (room.roomState.phase) setStatus(room.roomState.phase);
            else setStatus('lobby');
        };
        init();

        return () => {
            if (cleanupRoom) cleanupRoom();
            if (cleanupPresence) cleanupPresence();
        };
    }, []);

    React.useEffect(() => {
        if (roomState.phase) {
            setStatus(roomState.phase);
        }
    }, [roomState.phase]);

    // --- GAME ACTIONS ---

    const startGame = () => {
        const humanIds = Object.keys(peers);
        if (humanIds.length < 1) return; 

        // 1. Setup Players (Add AI if solo)
        const PERSONALITY_TYPES = ['AGGRESSIVE', 'DEFENSIVE', 'EXPANSIVE', 'BALANCED'];
        
        let players = humanIds.map((id, index) => ({
            id: id,
            isAI: false,
            colorIndex: index + 1,
            energy: STARTING_ENERGY,
            score: 0,
            username: peers[id].username
        }));

        // Fill with AI until 4 players
        if (players.length < MAX_PLAYERS) {
            const aiNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'];
            let aiCount = 0;
            while (players.length < MAX_PLAYERS) {
                const pType = PERSONALITY_TYPES[Math.floor(Math.random() * PERSONALITY_TYPES.length)];
                players.push({
                    id: `ai-${aiCount}`,
                    isAI: true,
                    personality: pType, 
                    colorIndex: players.length + 1,
                    energy: STARTING_ENERGY,
                    score: 0,
                    username: `Bot ${aiNames[aiCount]} [${pType.substring(0,3)}]`
                });
                aiCount++;
            }
        }

        // 2. Setup Grid with Terrain
        const grid = getHexGrid(BOARD_RADIUS);
        const board = {};
        grid.forEach(hex => {
            const dist = hexDistance(hex, {q:0, r:0});
            // 8% Void holes (exclude center area)
            if (dist > 2 && Math.random() < 0.08) return;

            let type = 'NORMAL';
            let item = null;
            
            // 15% Mountains (Defensive Bonus, Higher Cost)
            if (Math.random() < 0.15) type = 'MOUNTAIN';

            // 8% Powerups on normal tiles
            if (type === 'NORMAL' && Math.random() < 0.08) {
                const rand = Math.random();
                if (rand < 0.5) item = 'energy';
                else if (rand < 0.8) item = 'crystal';
                else item = 'shockwave';
            }

            board[getKey(hex)] = { ...hex, owner: null, strength: 0, type, item };
        });

        // 3. Assign Starts
        const starts = [];
        // Adjusted for radius 6
        if (players.length === 1) starts.push({q:0, r:0});
        else if (players.length === 2) { starts.push({q:0, r:-5}, {q:0, r:5}); }
        else {
             starts.push({q:0, r:-5}, {q:5, r:-5}, {q:5, r:0}, {q:0, r:5}, {q:-5, r:5}, {q:-5, r:0});
        }

        players.forEach((p, i) => {
            if (i < starts.length) {
                const hexKey = getKey(starts[i]);
                if (board[hexKey]) {
                    board[hexKey].owner = p.id;
                    board[hexKey].strength = 3;
                }
            }
        });

        room.updateRoomState({
            phase: 'playing',
            board,
            players,
            turnIndex: 0,
            totalTurns: 0,
            gameLog: ['Game Started!'],
            turnStartTime: Date.now()
        });
        
        playSound('deploy');
    };

    // AI Logic Loop (Sequential Moves)
    const aiRef = React.useRef(false);

    React.useEffect(() => {
        if (status !== 'playing' || !roomState.players) return;
        
        const currentPlayer = roomState.players[roomState.turnIndex];
        if (!currentPlayer?.isAI) return;

        // Host determines AI
        const connectedIds = Object.keys(peers).sort();
        const amIHost = connectedIds.length > 0 && connectedIds[0] === myId;
        
        if (amIHost && !aiRef.current) {
            aiRef.current = true;
            executeAITurnSequence(currentPlayer);
        }
    }, [roomState.turnIndex, roomState.phase, status, peers]);

    const delay = ms => new Promise(res => setTimeout(res, ms));

    const executeAITurnSequence = async (originalAiPlayer) => {
        // AI Personality Weights
        const weights = {
            BALANCED: { deploy: 1.0, overload: 1.0, fortify: 1.0, reinforce: 1.0, strike: 1.0 },
            AGGRESSIVE: { deploy: 0.8, overload: 1.4, fortify: 0.6, reinforce: 0.8, strike: 1.5 },
            DEFENSIVE: { deploy: 0.8, overload: 0.6, fortify: 1.4, reinforce: 1.5, strike: 0.5 },
            EXPANSIVE: { deploy: 1.4, overload: 0.8, fortify: 0.8, reinforce: 0.8, strike: 0.8 }
        };

        const personality = originalAiPlayer.personality || 'BALANCED';
        const w = weights[personality];

        await delay(800);

        let moves = 0;
        let canMove = true;
        const MAX_MOVES = Math.max(8, originalAiPlayer.energy);

        while (canMove && moves < MAX_MOVES) {
            const freshState = room.roomState;
            if (freshState.phase !== 'playing') break;
            
            let players = [...freshState.players];
            let board = { ...freshState.board };
            let turnIndex = freshState.turnIndex;
            let aiPlayer = players[turnIndex];

            if (aiPlayer.id !== originalAiPlayer.id) break;
            if (aiPlayer.energy <= 0) break;

            let bestMove = null;
            let bestScore = -Infinity;

            const myTiles = Object.values(board).filter(t => t.owner === aiPlayer.id);
            const hasTiles = myTiles.length > 0;
            const enemyTiles = Object.values(board).filter(t => t.owner && t.owner !== aiPlayer.id);

            // 1. DEPLOY
            if (aiPlayer.energy >= COSTS.DEPLOY) {
                let candidates = [];
                if (!hasTiles) {
                    candidates = Object.values(board).filter(t => !t.owner);
                } else {
                    const potentialKeys = new Set();
                    myTiles.forEach(t => {
                        getNeighbors(t).forEach(n => potentialKeys.add(getKey(n)));
                    });
                    candidates = Array.from(potentialKeys)
                        .map(k => board[k])
                        .filter(t => t && (!t.owner || !players.some(p => p.id === t.owner))); 
                }

                candidates.forEach(target => {
                    const neighbors = getNeighbors(target);
                    const emptyNeighbors = neighbors.filter(n => {
                        const cell = board[getKey(n)];
                        return cell && !cell.owner;
                    }).length;
                    const myNeighbors = neighbors.filter(n => {
                        const cell = board[getKey(n)];
                        return cell && cell.owner === aiPlayer.id;
                    }).length;

                    let rawScore = 10 + (emptyNeighbors * 2) + myNeighbors;
                    if (target.item) rawScore += 30; // Prioritize items
                    if (target.type === 'MOUNTAIN') rawScore -= 5;

                    let score = rawScore * w.deploy;
                    if (score > bestScore) {
                        bestScore = score;
                        bestMove = { type: 'DEPLOY', target: target };
                    }
                });
            }

            // 2. OVERLOAD (Adjacent Attack)
            if (aiPlayer.energy >= COSTS.OVERLOAD) {
                const uniqueTargets = [...new Set(myTiles.flatMap(t => 
                    getNeighbors(t).map(n => board[getKey(n)]).filter(target => 
                        target && target.owner && target.owner !== aiPlayer.id
                    )
                ))];

                uniqueTargets.forEach(target => {
                    const neighbors = getNeighbors(target);
                    const mySupport = neighbors.reduce((max, n) => {
                        const cell = board[getKey(n)];
                        return (cell && cell.owner === aiPlayer.id) ? Math.max(max, cell.strength) : max;
                    }, 0);

                    if (mySupport > target.strength) {
                        let rawScore = 25 + (target.strength * 4); 
                        let score = rawScore * w.overload;
                        if (score > bestScore) {
                            bestScore = score;
                            bestMove = { type: 'OVERLOAD', target: target };
                        }
                    }
                });
            }

            // 3. REINFORCE (Big Defense)
            if (aiPlayer.energy >= COSTS.REINFORCE) {
                myTiles.forEach(tile => {
                     if (tile.strength >= 12) return;
                     const neighbors = getNeighbors(tile);
                     const enemies = neighbors.filter(n => {
                        const c = board[getKey(n)];
                        return c && c.owner && c.owner !== aiPlayer.id;
                     }).length;

                     let rawScore = (enemies * 8) + (8 - tile.strength);
                     if (enemies === 0 && tile.strength < 5) rawScore = 5; 

                     let score = rawScore * w.reinforce;
                     if (score > bestScore) {
                         bestScore = score;
                         bestMove = { type: 'REINFORCE', target: tile };
                     }
                });
            }

            // 4. STRIKE (Global Attack)
            if (aiPlayer.energy >= COSTS.STRIKE && enemyTiles.length > 0) {
                 // Target high value weak spots
                 enemyTiles.forEach(target => {
                     if (target.strength <= 4) {
                         let rawScore = 15 + (10 - target.strength);
                         // Bonus if killing it disconnects? Too complex.
                         // Bonus if it's the leader?
                         const owner = players.find(p => p.id === target.owner);
                         if (owner && owner.score > aiPlayer.score) rawScore += 10;

                         let score = rawScore * w.strike;
                         if (score > bestScore) {
                             bestScore = score;
                             bestMove = { type: 'STRIKE', target: target };
                         }
                     }
                 });
            }

            // 5. FORTIFY (Small Defense) - fallback
            if (aiPlayer.energy >= COSTS.FORTIFY) {
                myTiles.forEach(tile => {
                    if (tile.strength >= 10) return; 
                    const neighbors = getNeighbors(tile);
                    const enemies = neighbors.some(n => {
                        const c = board[getKey(n)];
                        return c && c.owner && c.owner !== aiPlayer.id;
                    });
                    
                    let rawScore = enemies ? 10 : 2;
                    let score = rawScore * w.fortify;
                    if (score > bestScore) {
                        bestScore = score;
                        bestMove = { type: 'FORTIFY', target: tile };
                    }
                });
            }

            // Execute
            if (bestMove) {
                const k = getKey(bestMove.target);
                let capturedItem = null;

                // Move Costs
                let moveCost = COSTS[bestMove.type];
                if (board[k].type === 'MOUNTAIN' && bestMove.type === 'DEPLOY') moveCost += 1;
                if (board[k].type === 'MOUNTAIN' && bestMove.type === 'OVERLOAD') moveCost += 1;

                // Perform Logic
                let sfxName = 'deploy';
                if (bestMove.type === 'DEPLOY') {
                    board[k] = { ...board[k], owner: aiPlayer.id, strength: 1 };
                    capturedItem = board[k].item;
                } else if (bestMove.type === 'OVERLOAD') {
                    board[k] = { ...board[k], owner: aiPlayer.id, strength: Math.max(1, board[k].strength - 1) };
                    sfxName = 'overload';
                } else if (bestMove.type === 'FORTIFY') {
                    board[k].strength += 1;
                } else if (bestMove.type === 'REINFORCE') {
                    board[k].strength += 5;
                    sfxName = 'powerup';
                } else if (bestMove.type === 'STRIKE') {
                    board[k].strength -= 4;
                    if (board[k].strength <= 0) {
                        board[k].strength = 0;
                        board[k].owner = null;
                    }
                    sfxName = 'strike';
                }

                aiPlayer.energy -= moveCost;
                playSound(sfxName);

                // Handle Item Capture
                if (capturedItem) {
                    if (capturedItem === 'energy') { aiPlayer.energy += 5; }
                    else if (capturedItem === 'crystal') { board[k].strength += 5; playSound('powerup'); }
                    else if (capturedItem === 'shockwave') {
                        getNeighbors(board[k]).forEach(n => {
                            const nk = getKey(n);
                            if (board[nk] && board[nk].owner && board[nk].owner !== aiPlayer.id) {
                                board[nk].strength -= 3;
                                if (board[nk].strength <= 0) { board[nk].strength = 0; board[nk].owner = null; }
                            }
                        });
                        playSound('strike');
                    }
                    board[k].item = null;
                }

                // Update scores
                players[turnIndex] = aiPlayer;
                const totalHexes = Object.keys(board).length;
                players.forEach(p => {
                    const owned = Object.values(board).filter(c => c.owner === p.id).length;
                    p.score = owned;
                    if (owned / totalHexes >= WIN_PCT) {
                        // Trigger instant win
                        players = players.map(pl => ({...pl, score: pl.id === p.id ? 999 : 0})); // Force end
                    }
                });

                // Update Room State
                await room.updateRoomState({
                    board,
                    players
                });
                
                // Check Win
                const alive = players.filter(p => p.score > 0);
                if (alive.length === 1 && players.length > 1) {
                    room.updateRoomState({
                        phase: 'gameover',
                        winner: alive[0].id
                    });
                    aiRef.current = false;
                    return; 
                }

                moves++;
                // Check if we can afford anything else
                if (aiPlayer.energy < 1) canMove = false;
                
                await delay(400); 
            } else {
                canMove = false; // No valid moves found
            }
        }

        // End Turn
        const finalState = room.roomState;
        let players = [...finalState.players];
        let turnIndex = finalState.turnIndex;
        
        let nextIndex = (turnIndex + 1) % players.length;
        let attempts = 0;
        while (players[nextIndex].score === 0 && attempts < players.length) {
             nextIndex = (nextIndex + 1) % players.length;
             attempts++;
        }
        
        // Handle Turn Counter & Income
        const currentTotalTurns = finalState.totalTurns || 0;
        const newTotalTurns = currentTotalTurns + 1;
        
        // Only give income if everyone has played at least once (Round 2+)
        // Or if it's an old game state (undefined check)
        if (finalState.totalTurns === undefined || newTotalTurns >= players.length) {
            const nextId = players[nextIndex].id;
            const count = Object.values(finalState.board).filter(c => c.owner === nextId).length;
            const income = 2 + Math.floor(count / 3);
            players[nextIndex].energy += income;
        }

        await room.updateRoomState({
            players,
            turnIndex: nextIndex,
            totalTurns: newTotalTurns,
            turnStartTime: Date.now()
        });

        aiRef.current = false;
    };

    const handleHexClick = (hex) => {
        if (status !== 'playing') return;
        
        const myPlayerIndex = roomState.players.findIndex(p => p.id === myId);
        if (myPlayerIndex === -1) {
            showToast("You are spectating");
            return;
        }
        if (roomState.turnIndex !== myPlayerIndex) {
            showToast("Not your turn!");
            return;
        }
        if (!action) {
            showToast("Select an action first (Deploy, Fortify, Overload)");
            return;
        }

        const key = getKey(hex);
        const cell = roomState.board[key];
        if (!cell) return;

        let newBoard = JSON.parse(JSON.stringify(roomState.board));
        let newPlayers = JSON.parse(JSON.stringify(roomState.players));
        let currentPlayer = newPlayers[myPlayerIndex];
        let actionSuccess = false;

        // Terrain & Cost Logic
        let cost = 0;
        if (action === 'deploy') cost = COSTS.DEPLOY;
        else if (action === 'fortify') cost = COSTS.FORTIFY;
        else if (action === 'overload') cost = COSTS.OVERLOAD;
        else if (action === 'reinforce') cost = COSTS.REINFORCE;
        else if (action === 'strike') cost = COSTS.STRIKE;

        // Mountain penalty applies to movement/deployment, not remote attacks or reinforcement
        if (cell.type === 'MOUNTAIN' && (action === 'deploy' || action === 'overload')) cost += 1;

        if (currentPlayer.energy < cost) {
            showToast(`Need ${cost} energy (Terrain Penalty: ${cell.type==='MOUNTAIN' && action!=='fortify' ? '+1' : '0'})`);
            return;
        }

        if (action === 'deploy') {
            const isOccupied = cell.owner && roomState.players.some(p => p.id === cell.owner);
            if (isOccupied) {
                showToast("Target must be empty!");
                return;
            }
            const neighbors = getNeighbors(hex);
            const hasNeighbor = neighbors.some(n => {
                const nCell = roomState.board[getKey(n)];
                return nCell && nCell.owner === myId;
            });
            const hasAnyTile = Object.values(roomState.board).some(t => t.owner === myId);
            if (!hasNeighbor && hasAnyTile) {
                showToast("Must deploy adjacent to your territory");
                return;
            }
            newBoard[key].owner = myId;
            newBoard[key].strength = 1;
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('deploy');

        } else if (action === 'fortify') {
            if (cell.owner !== myId) return showToast("Target your own tile");
            if (cell.strength >= (cell.type === 'MOUNTAIN' ? 15 : 10)) return showToast("Max strength reached");
            newBoard[key].strength += 1;
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('deploy');

        } else if (action === 'reinforce') {
            if (cell.owner !== myId) return showToast("Target your own tile");
            newBoard[key].strength += 5;
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('powerup');
            showToast("Reinforcements arrived!");

        } else if (action === 'overload') {
            if (cell.owner === null || cell.owner === myId) return showToast("Target an enemy");
            const neighbors = getNeighbors(hex);
            const myStrongestAdj = neighbors.reduce((maxStr, n) => {
                const nCell = roomState.board[getKey(n)];
                if (nCell && nCell.owner === myId) return Math.max(maxStr, nCell.strength);
                return maxStr;
            }, 0);

            if (myStrongestAdj <= cell.strength) return showToast(`Insufficient power! Need > ${cell.strength} strength nearby.`);
            
            newBoard[key].owner = myId;
            newBoard[key].strength = Math.max(1, cell.strength - 1);
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('overload');

        } else if (action === 'strike') {
            if (!cell.owner || cell.owner === myId) return showToast("Target an enemy anywhere on map");
            newBoard[key].strength -= 4;
            if (newBoard[key].strength <= 0) {
                newBoard[key].strength = 0;
                newBoard[key].owner = null;
                showToast("Target neutralized!");
            } else {
                showToast("Target damaged!");
            }
            currentPlayer.energy -= cost;
            actionSuccess = true;
            playSound('strike');
        }

        if (actionSuccess) {
            // Check for item pickup if we now own the tile (Deploy or Overload)
            if (newBoard[key].owner === myId && newBoard[key].item) {
                const item = newBoard[key].item;
                if (item === 'energy') {
                    currentPlayer.energy += 5;
                    showToast("Energy Cache! +5⚡");
                } else if (item === 'crystal') {
                    newBoard[key].strength += 5;
                    playSound('powerup');
                    showToast("Power Crystal! +5 Strength");
                } else if (item === 'shockwave') {
                    // Damage all adjacent enemies
                    getNeighbors(hex).forEach(n => {
                        const nKey = getKey(n);
                        if (newBoard[nKey] && newBoard[nKey].owner && newBoard[nKey].owner !== myId) {
                            newBoard[nKey].strength -= 3;
                            if (newBoard[nKey].strength <= 0) {
                                newBoard[nKey].strength = 0;
                                newBoard[nKey].owner = null;
                            }
                        }
                    });
                    playSound('strike');
                    showToast("Shockwave Triggered!");
                }
                newBoard[key].item = null;
            }
            
            const totalHexes = Object.keys(newBoard).length;

            newPlayers.forEach(p => {
                const owned = Object.values(newBoard).filter(c => c.owner === p.id).length;
                p.score = owned;
            });

            const myOwned = newPlayers[myPlayerIndex].score;
            const domination = myOwned / totalHexes;

            room.updateRoomState({ board: newBoard, players: newPlayers });
            
            if (domination >= WIN_PCT) {
                endGame(myId);
                return;
            }

            const alivePlayers = newPlayers.filter(p => p.score > 0);
            if (alivePlayers.length === 1 && newPlayers.length > 1) {
                endGame(alivePlayers[0].id);
            }
        }
    };

    const endTurn = () => {
        const myPlayerIndex = roomState.players.findIndex(p => p.id === myId);
        if (roomState.turnIndex !== myPlayerIndex) return;

        let nextIndex = (roomState.turnIndex + 1) % roomState.players.length;
        let newPlayers = [...roomState.players];

        // Skip eliminated players
        let attempts = 0;
        while (newPlayers[nextIndex].score === 0 && attempts < newPlayers.length) {
             nextIndex = (nextIndex + 1) % newPlayers.length;
             attempts++;
        }
        
        // Handle Global Turn Counter
        const currentTotalTurns = roomState.totalTurns || 0;
        const newTotalTurns = currentTotalTurns + 1;

        // Income for next player (Only after everyone has played once)
        if (roomState.totalTurns === undefined || newTotalTurns >= newPlayers.length) {
            const nextPlayerId = newPlayers[nextIndex].id;
            const territoryCount = Object.values(roomState.board).filter(c => c.owner === nextPlayerId).length;
            const income = 2 + Math.floor(territoryCount / 3);
            newPlayers[nextIndex].energy += income;
        }

        let newBoard = roomState.board;
        // Spawn Items Every Full Round
        if (newTotalTurns > 0 && newTotalTurns % newPlayers.length === 0) {
            newBoard = { ...roomState.board }; // Clone
            const emptyTiles = Object.values(newBoard).filter(t => !t.owner && !t.item && t.type !== 'void');
            if (emptyTiles.length > 0) {
                // Spawn 1-2 items
                const count = Math.random() < 0.3 ? 2 : 1;
                for(let i=0; i<count; i++) {
                    if (emptyTiles.length === 0) break;
                    const idx = Math.floor(Math.random() * emptyTiles.length);
                    const tile = emptyTiles.splice(idx, 1)[0];
                    const rand = Math.random();
                    let itemType = 'energy';
                    if (rand > 0.5) itemType = 'crystal';
                    if (rand > 0.8) itemType = 'shockwave';
                    
                    newBoard[getKey(tile)].item = itemType;
                }
                showToast("Supply drop incoming!");
            }
        }

        room.updateRoomState({
            turnIndex: nextIndex,
            players: newPlayers,
            board: newBoard,
            totalTurns: newTotalTurns,
            turnStartTime: Date.now()
        });
    };

    const endGame = (winnerId) => {
        room.updateRoomState({ phase: 'gameover', winner: winnerId });
        playSound('victory');
        
        if (winnerId === myId) {
            updateStats(true, room.roomState.turnStartTime);
        } else {
            const wasPlayer = roomState.players.find(p => p.id === myId);
            if (wasPlayer) updateStats(false, room.roomState.turnStartTime);
        }
    };

    // --- RENDER ---

    const isMyTurn = status === 'playing' && roomState.players && roomState.players[roomState.turnIndex]?.id === myId;
    const myPlayer = roomState.players?.find(p => p.id === myId);

    const canAfford = (cost) => myPlayer && myPlayer.energy >= cost;

    const hexElements = [];
    if (roomState.board) {
        Object.values(roomState.board).forEach(hex => {
            const px = hexToPixel(hex);
            
            let colorClass = 'p0';
            if (hex.owner) {
                const ownerIdx = roomState.players.findIndex(p => p.id === hex.owner);
                if (ownerIdx >= 0) colorClass = `p${roomState.players[ownerIdx].colorIndex}`;
            }

            let opacity = 1;
            let stroke = null;
            let strokeWidth = null;
            let cursor = 'default';

            let isValidTarget = false;
            let classNames = `hex ${colorClass}`;

            if (hex.type === 'MOUNTAIN') {
                classNames += " mountain";
            }

            if (isMyTurn && action) {
                const neighbors = getNeighbors(hex);
                const hasFriendlyAdj = neighbors.some(n => {
                   const c = roomState.board[getKey(n)];
                   return c && c.owner === myId;
                });
                const hasAnyTile = Object.values(roomState.board).some(t => t.owner === myId);
                
                // --- Validation Logic ---
                if (action === 'deploy') {
                     const isOccupied = hex.owner && roomState.players.some(p => p.id === hex.owner);
                     isValidTarget = !isOccupied && (hasFriendlyAdj || !hasAnyTile);
                } else if (action === 'fortify') {
                     isValidTarget = hex.owner === myId;
                } else if (action === 'overload') {
                     if (hex.owner && hex.owner !== myId) {
                         const myStrongestAdj = neighbors.reduce((maxStr, n) => {
                            const nCell = roomState.board[getKey(n)];
                            if (nCell && nCell.owner === myId) return Math.max(maxStr, nCell.strength);
                            return maxStr;
                         }, 0);
                         isValidTarget = myStrongestAdj > hex.strength;
                     }
                } else if (action === 'reinforce') {
                    isValidTarget = hex.owner === myId;
                } else if (action === 'strike') {
                    isValidTarget = hex.owner && hex.owner !== myId;
                }

                if (isValidTarget) {
                    classNames += " valid-target";
                    cursor = 'pointer';
                } else {
                    classNames += " invalid-target";
                    opacity = 0.3;
                }
            } else if (isMyTurn && !action && hex.owner === myId) {
                 // Hint that you can select this tile (maybe for info in future)
                 cursor = 'help';
            }

            // Height Effect (Shift Y)
            const yOffset = hex.type === 'MOUNTAIN' ? -6 : 0;
            const finalY = px.y + yOffset;

            // Height Shadow
            const shadow = hex.type === 'MOUNTAIN' ? (
                <polygon points="0,-24 26,-9 26,21 0,36 -26,21 -26,-9" fill="rgba(0,0,0,0.5)" transform="translate(0, 6)"/>
            ) : null;

            hexElements.push(
                <g key={getKey(hex)} 
                   transform={`translate(${px.x}, ${finalY})`}
                   onClick={() => handleHexClick(hex)}
                   className="hex-group"
                   style={{ cursor }}>
                    {shadow}
                    <polygon 
                        points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15" 
                        className={classNames}
                        style={{ opacity, stroke: stroke || undefined, strokeWidth: strokeWidth || undefined }}
                    />
                    {hex.item && !hex.owner && (
                        <g className="item-icon">
                            {hex.item === 'energy' && <image href="icon_energy.png" x="-10" y="-10" width="20" height="20" />}
                            {hex.item === 'crystal' && <image href="icon_shield.png" x="-10" y="-10" width="20" height="20" style={{filter:'hue-rotate(90deg)'}} />}
                            {hex.item === 'shockwave' && <image href="icon_attack.png" x="-10" y="-10" width="20" height="20" style={{filter:'hue-rotate(180deg)'}} />}
                        </g>
                    )}
                    {hex.strength > 0 && (
                        <text x="0" y="5" textAnchor="middle" className="hex-label">{hex.strength}</text>
                    )}
                </g>
            );
        });
    }

    if (status === 'loading') return <div className="screen"><h1>Initializing...</h1></div>;

    if (status === 'lobby') {
        const isHost = Object.keys(peers)[0] === myId;
        return (
            <div className="screen">
                <h1 className="neon-text">Neon Nebula</h1>
                <div style={{ display: 'flex', gap: '40px', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <div className="modal">
                        <h2>Lobby</h2>
                        <ul className="player-list">
                            {Object.values(peers).map(p => (
                                <li key={p.id}>
                                    <div style={{display:'flex', alignItems:'center'}}>
                                        <img src={p.avatarUrl} className="avatar"/>
                                        {p.username}
                                    </div>
                                    {p.id === myId && <span style={{color:'var(--primary)'}}>(You)</span>}
                                </li>
                            ))}
                        </ul>
                        {isHost ? (
                            <div style={{display:'flex', flexDirection:'column', gap:'10px'}}>
                                <button className="btn" disabled={Object.keys(peers).length < 1} onClick={startGame}>Start Conquest</button>
                                {Object.keys(peers).length === 1 && <span style={{fontSize:'0.8rem', color:'#888'}}>AI Bots will be added</span>}
                            </div>
                        ) : <p>Waiting for host...</p>}
                    </div>
                    <div className="modal">
                        <h2>Leaderboard</h2>
                        <ul className="player-list">
                            {leaderboard.map((record, i) => (
                                <li key={record.id}>#{i+1} {record.username} ({record.col_1?.elo})</li>
                            ))}
                        </ul>
                    </div>
                </div>
            </div>
        );
    }

    if (status === 'gameover') {
        const winner = roomState.players.find(p => p.id === roomState.winner);
        return (
            <div className="screen">
                <div className="modal">
                    <h1>{roomState.winner === myId ? "VICTORY" : "DEFEAT"}</h1>
                    <p>Winner: {winner?.username}</p>
                    <button className="btn" onClick={() => room.updateRoomState({ phase: 'lobby' })}>Return</button>
                </div>
            </div>
        );
    }

    // Using a fixed viewBox centered at 0,0 to automatically scale the board
    // Board radius 4 * 30px ~ 120px + padding => 300px range
    return (
        <div className="screen">
            <div className="hud-top">
                <div style={{display:'flex', gap:'10px'}}>
                    {roomState.players.map(p => (
                        <div key={p.id} className={`turn-indicator ${roomState.players[roomState.turnIndex].id === p.id ? 'turn-active' : ''}`}
                             style={{ color: p.score === 0 ? '#555' : (p.colorIndex === 1 ? '#00f0ff' : p.colorIndex === 2 ? '#ff0055' : p.colorIndex === 3 ? '#ccff00' : '#bd00ff') }}>
                            {p.username} ({p.score})
                        </div>
                    ))}
                </div>
                <div>{myPlayer && <div style={{ fontSize: '1.5rem', color: 'var(--accent)' }}>⚡ {myPlayer.energy}</div>}</div>
            </div>

            <div className="game-board-container">
                <svg className="hex-grid" viewBox="-500 -450 1000 900" preserveAspectRatio="xMidYMid meet">
                    {hexElements}
                </svg>
            </div>

            {isMyTurn ? (
                <div className="hud-bottom">
                    <div className={`action-card ${action === 'deploy' ? 'selected' : ''}`} onClick={() => setAction(action==='deploy'?null:'deploy')}
                         style={{opacity:canAfford(COSTS.DEPLOY)?1:0.5}}>
                        <img src="icon_energy.png"/><span>Deploy ({COSTS.DEPLOY})</span>
                    </div>
                    <div className={`action-card ${action === 'fortify' ? 'selected' : ''}`} onClick={() => setAction(action==='fortify'?null:'fortify')}
                         style={{opacity:canAfford(COSTS.FORTIFY)?1:0.5}}>
                        <img src="icon_shield.png"/><span>Fortify ({COSTS.FORTIFY})</span>
                    </div>
                    <div className={`action-card ${action === 'overload' ? 'selected' : ''}`} onClick={() => setAction(action==='overload'?null:'overload')}
                         style={{opacity:canAfford(COSTS.OVERLOAD)?1:0.5}}>
                        <img src="icon_attack.png"/><span>Overload ({COSTS.OVERLOAD})</span>
                    </div>
                    <div className={`action-card ${action === 'reinforce' ? 'selected' : ''}`} onClick={() => setAction(action==='reinforce'?null:'reinforce')}
                         style={{opacity:canAfford(COSTS.REINFORCE)?1:0.5}}>
                        <img src="icon_buff.png"/><span>Boost ({COSTS.REINFORCE})</span>
                    </div>
                    <div className={`action-card ${action === 'strike' ? 'selected' : ''}`} onClick={() => setAction(action==='strike'?null:'strike')}
                         style={{opacity:canAfford(COSTS.STRIKE)?1:0.5}}>
                        <img src="icon_strike.png"/><span>Strike ({COSTS.STRIKE})</span>
                    </div>
                    <button className="btn btn-secondary" onClick={endTurn} style={{marginLeft:'20px'}}>End</button>
                </div>
            ) : (
                <div className="hud-bottom"><p>Waiting for {roomState.players[roomState.turnIndex]?.username}...</p></div>
            )}
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Game />);