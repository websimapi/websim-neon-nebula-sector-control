import { getHexGrid, hexToPixel, getKey, getNeighbors, hexDistance } from './hex_engine.js';

// --- CONFIG ---
const MAX_PLAYERS = 4;
const BOARD_RADIUS = 4;
const STARTING_ENERGY = 3;
const COSTS = {
    DEPLOY: 2,
    FORTIFY: 1,
    OVERLOAD: 3
};

// --- AUDIO ---
const sfx = {
    deploy: new Audio('sfx_deploy.mp3'),
    overload: new Audio('sfx_overload.mp3'),
    victory: new Audio('sfx_victory.mp3')
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
        const playerIds = Object.keys(peers);
        if (playerIds.length < 1) return; 

        // 1. Setup Grid
        const grid = getHexGrid(BOARD_RADIUS);
        const board = {};
        grid.forEach(hex => {
            board[getKey(hex)] = { ...hex, owner: null, strength: 0 };
        });

        // 2. Setup Players
        const players = playerIds.map((id, index) => ({
            id: id,
            colorIndex: index + 1,
            energy: STARTING_ENERGY,
            score: 0,
            username: peers[id].username
        }));

        // 3. Assign Starts
        const starts = [];
        if (players.length === 1) starts.push({q:0, r:0});
        else if (players.length === 2) { starts.push({q:0, r:-4}, {q:0, r:4}); }
        else {
             starts.push({q:0, r:-4}, {q:4, r:-4}, {q:4, r:0}, {q:0, r:4}, {q:-4, r:4}, {q:-4, r:0});
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
            turnStartTime: Date.now()
        });
        
        playSound('deploy');
    };

    const handleHexClick = (hex) => {
        if (status !== 'playing') return;
        
        const myPlayerIndex = roomState.players.findIndex(p => p.id === myId);
        if (myPlayerIndex === -1) return; // Spectator
        if (roomState.turnIndex !== myPlayerIndex) return; // Not my turn

        const key = getKey(hex);
        const cell = roomState.board[key];
        if (!cell) return;

        let newBoard = { ...roomState.board };
        let newPlayers = [...roomState.players];
        let currentPlayer = { ...newPlayers[myPlayerIndex] };
        let actionSuccess = false;

        if (action === 'deploy') {
            if (currentPlayer.energy >= COSTS.DEPLOY && cell.owner === null) {
                const neighbors = getNeighbors(hex);
                const hasNeighbor = neighbors.some(n => {
                    const nKey = getKey(n);
                    return roomState.board[nKey] && roomState.board[nKey].owner === myId;
                });
                const hasAnyTile = Object.values(roomState.board).some(t => t.owner === myId);

                if (hasNeighbor || !hasAnyTile) {
                    newBoard[key] = { ...cell, owner: myId, strength: 1 };
                    currentPlayer.energy -= COSTS.DEPLOY;
                    actionSuccess = true;
                    playSound('deploy');
                }
            }
        } else if (action === 'fortify') {
            if (currentPlayer.energy >= COSTS.FORTIFY && cell.owner === myId) {
                newBoard[key] = { ...cell, strength: cell.strength + 1 };
                currentPlayer.energy -= COSTS.FORTIFY;
                actionSuccess = true;
                playSound('deploy');
            }
        } else if (action === 'overload') {
            if (currentPlayer.energy >= COSTS.OVERLOAD && cell.owner !== null && cell.owner !== myId) {
                const neighbors = getNeighbors(hex);
                const myStrongestAdj = neighbors.reduce((maxStr, n) => {
                    const nKey = getKey(n);
                    const nCell = roomState.board[nKey];
                    if (nCell && nCell.owner === myId) return Math.max(maxStr, nCell.strength);
                    return maxStr;
                }, 0);

                if (myStrongestAdj > cell.strength) {
                    newBoard[key] = { ...cell, owner: myId, strength: Math.max(1, cell.strength - 1) };
                    currentPlayer.energy -= COSTS.OVERLOAD;
                    actionSuccess = true;
                    playSound('overload');
                }
            }
        }

        if (actionSuccess) {
            newPlayers[myPlayerIndex] = currentPlayer;
            newPlayers.forEach(p => {
                p.score = Object.values(newBoard).filter(c => c.owner === p.id).length;
            });

            room.updateRoomState({ board: newBoard, players: newPlayers });
            
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
        
        // Income for next player
        const nextPlayerId = newPlayers[nextIndex].id;
        const territoryCount = Object.values(roomState.board).filter(c => c.owner === nextPlayerId).length;
        const income = 2 + Math.floor(territoryCount / 3);
        newPlayers[nextIndex].energy += income;

        room.updateRoomState({
            turnIndex: nextIndex,
            players: newPlayers,
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
            if (isMyTurn && action) {
                // ... (highlight logic kept simpler for brevity)
                const neighbors = getNeighbors(hex);
                const hasFriendlyAdj = neighbors.some(n => {
                   const c = roomState.board[getKey(n)];
                   return c && c.owner === myId;
                });
                if (action === 'deploy') {
                     if (!(hex.owner === null && (hasFriendlyAdj || !Object.values(roomState.board).some(t => t.owner === myId)))) opacity = 0.3;
                     else stroke = 'white';
                } else if (action === 'fortify') {
                     if (hex.owner !== myId) opacity = 0.3;
                     else stroke = 'white';
                } else if (action === 'overload') {
                     if (!(hex.owner && hex.owner !== myId && hasFriendlyAdj)) opacity = 0.3;
                     else stroke = 'red';
                }
            }

            hexElements.push(
                <g key={getKey(hex)} 
                   transform={`translate(${px.x}, ${px.y})`}
                   onClick={() => handleHexClick(hex)}
                   className="hex-group">
                    <polygon 
                        points="0,-30 26,-15 26,15 0,30 -26,15 -26,-15" 
                        className={`hex ${colorClass}`}
                        style={{ opacity, stroke: stroke || undefined }}
                    />
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
                            <button className="btn" disabled={Object.keys(peers).length < 1} onClick={startGame}>Start Conquest</button>
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
                <svg className="hex-grid" viewBox="-400 -350 800 700" preserveAspectRatio="xMidYMid meet">
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
                    <button className="btn btn-secondary" onClick={endTurn} style={{marginLeft:'20px'}}>End Turn</button>
                </div>
            ) : (
                <div className="hud-bottom"><p>Waiting for {roomState.players[roomState.turnIndex]?.username}...</p></div>
            )}
        </div>
    );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<Game />);