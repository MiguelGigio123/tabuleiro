const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d', { alpha: false });

const minimap = document.getElementById('minimap');
const mCtx = minimap.getContext('2d');

// UI Elements
const hud = document.getElementById('hud');
const startScreen = document.getElementById('start-screen');
const gameOverScreen = document.getElementById('game-over-screen');
const startBtn = document.getElementById('start-btn');
const restartBtn = document.getElementById('restart-btn');

const speedEl = document.getElementById('speed');
const gearEl = document.getElementById('gear');
const lapEl = document.getElementById('lap');
const timeEl = document.getElementById('time');
const bestTimeEl = document.getElementById('best-time');
const finalTimeEl = document.getElementById('final-time');
const finalBestEl = document.getElementById('final-best');
const posEl = document.getElementById('position');

const trackButtons = document.querySelectorAll('.track-btn');

// Game State
let gameState = 'START';
let lastTime = 0;
let uiUpdateTimer = 0;

let raceStartTime = 0;
let currentLapStartTime = 0;
let bestLapTime = Infinity;
let totalRaceTime = 0;
let currentLap = 1;
const totalLaps = 3;

// Selection
let selectedTrackIndex = 0;

trackButtons.forEach(btn => {
    btn.addEventListener('click', () => {
        trackButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        selectedTrackIndex = parseInt(btn.getAttribute('data-track'));
        // Initial render background with new track
        initialRender();
    });
});

const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowLeft: false, ArrowDown: false, ArrowRight: false, " ": false };

// Track Setup
const trackWidth = 250;
const TRACKS = [
    {
        name: "MONZA",
        points: [
            {x: 0, y: 1000}, {x: 1800, y: 1000}, {x: 2200, y: -200}, {x: 1500, y: -1500},
            {x: -500, y: -1800}, {x: -1800, y: -800}, {x: -1500, y: 500}, {x: -500, y: 1000}
        ]
    },
    {
        name: "SUZUKA", // Techy figure-8ish
        points: [
            {x: 0, y: 0}, {x: 1000, y: 0}, {x: 2000, y: 1000}, {x: 1000, y: 2000},
            {x: -1000, y: 2000}, {x: -2000, y: 1000}, {x: -1000, y: -1000}, {x: 0, y: -1000}
        ]
    },
    {
        name: "OVAL",
        points: [
            {x: 0, y: 1000}, {x: 2000, y: 1000}, {x: 2500, y: 500}, {x: 2500, y: -500},
            {x: 2000, y: -1000}, {x: -2000, y: -1000}, {x: -2500, y: -500}, {x: -2500, y: 500},
            {x: -2000, y: 1000}
        ]
    }
];

let trackPath = [];

// Audio System Variables
let audioCtx = null;
let engineOsc = null;
let engineGain = null;
let slipFilter = null;
let slipGain = null;

function initAudio() {
    if (audioCtx) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // Engine sound 
        engineOsc = audioCtx.createOscillator();
        engineOsc.type = 'sawtooth';
        engineOsc.frequency.value = 50; 
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 1000;

        engineGain = audioCtx.createGain();
        engineGain.gain.value = 0.05; // Base Volume

        engineOsc.connect(filter);
        filter.connect(engineGain);
        engineGain.connect(audioCtx.destination);
        engineOsc.start();

        // Skid Sound via Noise Buffer
        let bufferSize = audioCtx.sampleRate * 2; 
        let noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        let output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }

        let noiseSrc = audioCtx.createBufferSource();
        noiseSrc.buffer = noiseBuffer;
        noiseSrc.loop = true;

        slipFilter = audioCtx.createBiquadFilter();
        slipFilter.type = 'bandpass';
        slipFilter.frequency.value = 1000;

        slipGain = audioCtx.createGain();
        slipGain.gain.value = 0;

        noiseSrc.connect(slipFilter);
        slipFilter.connect(slipGain);
        slipGain.connect(audioCtx.destination);
        noiseSrc.start();
    } catch(e) {
        console.warn("Audio system initialization failed", e);
    }
}

// Entities
const car = {
    x: 0, y: 0, vx: 0, vy: 0,
    angle: 0, speed: 0, maxSpeed: 25,
    accel: 0.18, brakeForce: 0.35,
    friction: 0.985, grassFriction: 0.93, turnSpeed: 0.045
};

let bots = [];
const particles = [];
const skidmarks = [];

class BotCar {
    constructor(x, y, color, speedVariance) {
        this.x = x; this.y = y; this.vx = 0; this.vy = 0;
        this.angle = 0; this.speed = 0; this.color = color;
        this.checkpoint = 0;
        this.highestCheckpoint = 0;
        this.lastCheckpoint = 0;
        this.currentLap = 1;
        this.maxSpeed = 16 + speedVariance; 
        this.accel = 0.12 + Math.random()*0.03;
        this.lookAhead = 3 + Math.floor(Math.random()*2);
    }
    
    update() {
        // Find closest path index
        let minD = Infinity;
        let cIdx = this.checkpoint;
        
        for(let i=-5; i<=5; i++){
            let idx = (this.checkpoint + i + trackPath.length) % trackPath.length;
            let d = Math.hypot(this.x - trackPath[idx].x, this.y - trackPath[idx].y);
            if (d < minD){
                minD = d;
                cIdx = idx;
            }
        }
        this.checkpoint = cIdx;

        let nPts = trackPath.length;
        if (cIdx > this.highestCheckpoint && cIdx <= this.highestCheckpoint + Math.floor(nPts/4)) {
            this.highestCheckpoint = cIdx;
        }
        if (this.lastCheckpoint > nPts * 0.9 && cIdx < nPts * 0.1 && this.highestCheckpoint > nPts * 0.5) {
            this.currentLap++;
            this.highestCheckpoint = 0;
        }
        this.lastCheckpoint = cIdx;

        // Target point
        let targetIdx = (this.checkpoint + this.lookAhead) % trackPath.length;
        let tx = trackPath[targetIdx].x;
        let ty = trackPath[targetIdx].y;
        
        // Offset logic for bots so they don't drive exact same path
        let offset = Math.sin(this.checkpoint * 0.5) * 50; 
        
        let targetAngle = Math.atan2(ty - this.y, tx - this.x);
        
        // Angle to target
        let angleDiff = targetAngle - this.angle;
        while (angleDiff <= -Math.PI) angleDiff += Math.PI * 2;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

        this.angle += angleDiff * 0.05;

        // Speed control
        let isSharpTurn = Math.abs(angleDiff) > 0.4;
        let engineForce = this.accel;
        if (isSharpTurn && this.speed > this.maxSpeed * 0.5) {
            engineForce = -0.1; // Brake
        } else if (this.speed > this.maxSpeed) {
            engineForce = 0;
        }

        this.vx += Math.cos(this.angle) * engineForce;
        this.vy += Math.sin(this.angle) * engineForce;
        this.vx *= 0.985;
        this.vy *= 0.985;

        this.x += this.vx;
        this.y += this.vy;
        this.speed = Math.hypot(this.vx, this.vy);
    }
    
    draw(ctx) {
        ctx.save();
        ctx.translate(this.x, this.y);
        ctx.rotate(this.angle);
        
        // Tires
        ctx.fillStyle = '#111';
        ctx.fillRect(10, -15, 12, 6);
        ctx.fillRect(10, 9, 12, 6);
        ctx.fillRect(-15, -15, 12, 6);
        ctx.fillRect(-15, 9, 12, 6);

        // Body
        ctx.fillStyle = this.color;
        ctx.beginPath();
        ctx.moveTo(25, 0); ctx.lineTo(15, -10);
        ctx.lineTo(-20, -10); ctx.lineTo(-20, 10);
        ctx.lineTo(15, 10); ctx.fill();
        
        ctx.fillStyle = '#050505';
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI*2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(-2, 0, 3, 0, Math.PI*2);
        ctx.fill();

        ctx.restore();
    }
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

window.addEventListener('keydown', (e) => { if (keys.hasOwnProperty(e.key)) keys[e.key] = true; });
window.addEventListener('keyup', (e) => { if (keys.hasOwnProperty(e.key)) keys[e.key] = false; });

function generateSmoothTrack(pts, iterations) {
    if (iterations === 0) return pts;
    let newPts = [];
    for (let i = 0; i < pts.length; i++) {
        let p0 = pts[i];
        let p1 = pts[(i + 1) % pts.length];
        newPts.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
        newPts.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    return generateSmoothTrack(newPts, iterations - 1);
}

function distToSegment(p, v, w) {
    let l2 = (w.x - v.x) * (w.x - v.x) + (w.y - v.y) * (w.y - v.y);
    if (l2 === 0) return Math.sqrt((p.x - v.x) * (p.x - v.x) + (p.y - v.y) * (p.y - v.y));
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.sqrt(
        (p.x - (v.x + t * (w.x - v.x))) * (p.x - (v.x + t * (w.x - v.x))) +
        (p.y - (v.y + t * (w.y - v.y))) * (p.y - (v.y + t * (w.y - v.y)))
    );
}

function getTrackInfo(point) {
    let minDist = Infinity;
    let closestIndex = 0;
    for (let i = 0; i < trackPath.length; i++) {
        let d = distToSegment(point, trackPath[i], trackPath[(i + 1) % trackPath.length]);
        if (d < minDist) {
            minDist = d;
            closestIndex = i;
        }
    }
    return { dist: minDist, checkpoint: closestIndex };
}

let highestCheckpoint = 0;
let lastCheckpoint = 0;

function initGame() {
    initAudio();

    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    trackPath = generateSmoothTrack(TRACKS[selectedTrackIndex].points, 4);
    
    let startAngle = Math.atan2(trackPath[1].y - trackPath[0].y, trackPath[1].x - trackPath[0].x);
    
    // Position Player
    car.x = trackPath[0].x;
    car.y = trackPath[0].y;
    car.angle = startAngle;
    car.vx = 0; car.vy = 0; car.speed = 0;

    // Generate Bots
    bots = [
        new BotCar(car.x - Math.cos(car.angle)*150 + Math.sin(car.angle)*60, car.y - Math.sin(car.angle)*150 - Math.cos(car.angle)*60, '#2a88ff', 1),
        new BotCar(car.x - Math.cos(car.angle)*250 - Math.sin(car.angle)*60, car.y - Math.sin(car.angle)*250 + Math.cos(car.angle)*60, '#2aff2a', 2),
        new BotCar(car.x - Math.cos(car.angle)*350 + Math.sin(car.angle)*60, car.y - Math.sin(car.angle)*350 - Math.cos(car.angle)*60, '#ffff2a', 3)
    ];
    bots.forEach(b => {
        b.angle = startAngle;
        b.highestCheckpoint = 0;
        b.lastCheckpoint = 0;
        b.currentLap = 1;
    });

    currentLap = 1;
    raceStartTime = performance.now();
    currentLapStartTime = performance.now();
    bestLapTime = Infinity;
    skidmarks.length = 0;
    highestCheckpoint = 0;
    
    hud.classList.remove('hidden');
    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    
    gameState = 'PLAYING';
    requestAnimationFrame(gameLoop);
}

function handlePhysics() {
    // Player Physics Input
    let engineForce = 0;
    if (keys.w || keys.ArrowUp) engineForce = car.accel;
    if (keys.s || keys.ArrowDown) engineForce = -car.brakeForce;

    if (car.speed > 0.5) {
        let turnDir = (keys.d || keys.ArrowRight ? 1 : 0) - (keys.a || keys.ArrowLeft ? 1 : 0);
        let speedFactor = Math.max(0.6, 1 - (car.speed / 45)); 
        car.angle += turnDir * car.turnSpeed * speedFactor * Math.sign(car.speed);
    }
    
    car.vx += Math.cos(car.angle) * engineForce;
    car.vy += Math.sin(car.angle) * engineForce;

    // Surface detection & Grip
    let trackInfo = getTrackInfo(car);
    let onGrass = trackInfo.dist > trackWidth / 2;
    let currentFriction = onGrass ? car.grassFriction : car.friction;
    
    car.vx *= currentFriction;
    car.vy *= currentFriction;

    let vMag = Math.hypot(car.vx, car.vy);
    car.speed = vMag;
    let isSliding = false;

    if (vMag > 0.1) {
        let vAngle = Math.atan2(car.vy, car.vx);
        let angleDiff = car.angle - vAngle;
        while (angleDiff <= -Math.PI) angleDiff += Math.PI * 2;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;

        let grip = 0.15;
        isSliding = Math.abs(angleDiff) > 0.25;

        // Handbrake
        if (keys[" "] && vMag > 5) {
            grip = 0.03; 
            isSliding = true;
        }
        if (onGrass) grip = 0.05;

        // Drift vector logic
        let targetVAngle = vAngle + angleDiff * grip;
        car.vx = Math.cos(targetVAngle) * vMag;
        car.vy = Math.sin(targetVAngle) * vMag;

        // Particles
        if (isSliding && vMag > 4 && !onGrass) {
            // Add skidmark points
            let rl = { x: car.x - Math.cos(car.angle)*15 + Math.sin(car.angle)*10, y: car.y - Math.sin(car.angle)*15 - Math.cos(car.angle)*10 };
            let rr = { x: car.x - Math.cos(car.angle)*15 - Math.sin(car.angle)*10, y: car.y - Math.sin(car.angle)*15 + Math.cos(car.angle)*10 };
            skidmarks.push({x: rl.x, y: rl.y}, {x: rr.x, y: rr.y});
            
            if (Math.random() > 0.4) {
                particles.push({
                    x: rl.x + (Math.random()-0.5)*5, y: rl.y + (Math.random()-0.5)*5,
                    vx: -car.vx * 0.1, vy: -car.vy * 0.1,
                    life: 1.0, size: Math.random()*8 + 5
                });
            }
        }
    }

    if (skidmarks.length > 600) skidmarks.splice(0, 20);
    car.x += car.vx;
    car.y += car.vy;

    // AI logic
    for(let b of bots) b.update();

    // Check Collisions
    for(let b of bots) {
        let dx = car.x - b.x;
        let dy = car.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 30) {
            let pushX = (dx / dist) * 2;
            let pushY = (dy / dist) * 2;
            car.vx += pushX; car.vy += pushY;
            b.vx -= pushX; b.vy -= pushY;
        }
    }

    // Audio Modulator
    if (audioCtx) {
        if (audioCtx.state === 'suspended') audioCtx.resume();
        // Pitch mapping
        engineOsc.frequency.setTargetAtTime(60 + car.speed * 4, audioCtx.currentTime, 0.1);
        
        if (isSliding && car.speed > 5 && !onGrass) {
            slipFilter.frequency.value = 800;
            slipGain.gain.setTargetAtTime(0.3 + Math.random()*0.1, audioCtx.currentTime, 0.05);
        } else if (onGrass && car.speed > 2) {
            slipFilter.frequency.value = 300; // dirt sound
            slipGain.gain.setTargetAtTime(0.5, audioCtx.currentTime, 0.05);
        } else {
            slipGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);
        }
    }

    // Particle Lifecycle
    for (let i = particles.length - 1; i >= 0; i--) {
        particles[i].x += particles[i].vx; 
        particles[i].y += particles[i].vy;
        particles[i].life -= 0.05;
        if (particles[i].life <= 0) particles.splice(i, 1);
    }

    // Lap logic
    let cp = trackInfo.checkpoint;
    let nPts = trackPath.length;
    
    if (cp > highestCheckpoint && cp <= highestCheckpoint + Math.floor(nPts/4)) {
        highestCheckpoint = cp;
    }
    
    if (lastCheckpoint > nPts * 0.9 && cp < nPts * 0.1 && highestCheckpoint > nPts * 0.5) {
        completeLap();
    }
    lastCheckpoint = cp;
}

function completeLap() {
    let now = performance.now();
    let lapTime = now - currentLapStartTime;
    if (lapTime < bestLapTime) bestLapTime = lapTime;
    
    currentLap++;
    currentLapStartTime = now;
    highestCheckpoint = 0;

    if (currentLap > totalLaps) endRace();
}

function formatTime(ms) {
    if (ms === Infinity) return "--:--.--";
    let date = new Date(ms);
    let m = date.getMinutes().toString().padStart(2, '0');
    let s = date.getSeconds().toString().padStart(2, '0');
    let msStr = Math.floor(date.getMilliseconds() / 10).toString().padStart(2, '0');
    return `${m}:${s}.${msStr}`;
}

function endRace() {
    gameState = 'GAMEOVER';
    if(engineGain) engineGain.gain.setTargetAtTime(0, audioCtx.currentTime, 1);
    if(slipGain) slipGain.gain.setTargetAtTime(0, audioCtx.currentTime, 0.1);

    totalRaceTime = performance.now() - raceStartTime;
    finalTimeEl.innerText = formatTime(totalRaceTime);
    finalBestEl.innerText = formatTime(bestLapTime);
    
    gameOverScreen.classList.remove('hidden');
    hud.classList.add('hidden');
}

function drawTrack(ctx) {
    ctx.fillStyle = '#0f171e';
    ctx.fillRect(-20000, -20000, 40000, 40000);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Kerbs
    ctx.lineWidth = trackWidth + 24;
    ctx.beginPath();
    ctx.moveTo(trackPath[0].x, trackPath[0].y);
    for (let i = 1; i < trackPath.length; i++) ctx.lineTo(trackPath[i].x, trackPath[i].y);
    ctx.closePath();
    
    ctx.setLineDash([40, 40]);
    ctx.strokeStyle = '#ff2a2a';
    ctx.stroke();
    ctx.lineDashOffset = 40;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Asphalt
    ctx.lineWidth = trackWidth;
    ctx.strokeStyle = '#2a2c32';
    ctx.stroke();

    // Start/Finish Checkered line
    let p1 = trackPath[0], p2 = trackPath[1];
    let angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    ctx.save();
    ctx.translate(p1.x, p1.y);
    ctx.rotate(angle);
    ctx.fillStyle = '#fff';
    ctx.fillRect(-10, -trackWidth/2, 20, trackWidth);
    ctx.fillStyle = '#000';
    let sS = 25;
    for(let i=0; i<trackWidth/sS; i++){
        if(i%2===0) ctx.fillRect(-10, -trackWidth/2 + i*sS, 10, sS);
        if(i%2===1) ctx.fillRect(0, -trackWidth/2 + i*sS, 10, sS);
    }
    ctx.restore();

    // Skidmarks
    ctx.fillStyle = 'rgba(10, 10, 10, 0.3)';
    for(let sm of skidmarks) {
        ctx.beginPath(); ctx.arc(sm.x, sm.y, 4, 0, Math.PI*2); ctx.fill();
    }
}

function drawCar(ctx) {
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(car.angle);
    
    // Tires
    ctx.fillStyle = '#111';
    ctx.fillRect(15, -16, 16, 8); // FL
    ctx.fillRect(15, 8, 16, 8);  // FR
    ctx.fillRect(-15, -16, 16, 8); // RL
    ctx.fillRect(-15, 8, 16, 8);  // RR
    
    // Axles
    ctx.fillStyle = '#333';
    ctx.fillRect(15, -12, 2, 24);
    ctx.fillRect(-15, -12, 2, 24);

    // Body
    ctx.fillStyle = '#a22aff';
    ctx.beginPath();
    ctx.moveTo(30, 0); ctx.lineTo(20, -8);
    ctx.lineTo(-20, -10); ctx.lineTo(-20, 10);
    ctx.lineTo(20, 8); ctx.fill();

    // Wings
    ctx.fillStyle = '#111';
    ctx.fillRect(25, -14, 5, 28);
    ctx.fillRect(-22, -16, 6, 32);

    // Cockpit
    ctx.fillStyle = '#050505';
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-2, 0, 4, 0, Math.PI*2); ctx.fill();

    ctx.restore();
}

function drawWorldParticles(ctx) {
    for (let p of particles) {
        ctx.fillStyle = `rgba(200, 200, 200, ${p.life * 0.3})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI*2); ctx.fill();
    }
}

function updateHUD(now) {
    if (now - uiUpdateTimer > 50) {
        speedEl.innerText = Math.round(car.speed * 15);
        let gear = 'N';
        if (car.speed > 0.5) {
            let s = car.speed * 15;
            if (s < 50) gear = '1'; else if (s < 100) gear = '2';
            else if (s < 150) gear = '3'; else if (s < 220) gear = '4';
            else gear = '5';
        } else if ((keys.s || keys.ArrowDown) && car.speed < 1) {
            gear = 'R'; speedEl.innerText = Math.round(Math.abs(car.vy*15));
        }
        gearEl.innerText = gear;
        lapEl.innerText = `${Math.min(currentLap, totalLaps)}/${totalLaps}`;
        bestTimeEl.innerText = formatTime(bestLapTime);
        timeEl.innerText = formatTime(now - currentLapStartTime);
        
        let racers = [
            { isPlayer: true, score: currentLap * 10000 + highestCheckpoint },
            ...bots.map(b => ({ isPlayer: false, score: b.currentLap * 10000 + b.highestCheckpoint }))
        ];
        racers.sort((a, b) => b.score - a.score);
        let pos = racers.findIndex(r => r.isPlayer) + 1;
        let posStr = pos + (["ST","ND","RD"][((pos+90)%100-10)%10-1] || "TH");
        if(posEl) posEl.innerText = posStr;

        uiUpdateTimer = now;
        
        // Minimap Render
        mCtx.clearRect(0,0, minimap.width, minimap.height);
        let padding = 1000;
        let minX = -3000, maxX = 3000, minY = -3000, maxY = 3000;
        let tW = maxX - minX; let tH = maxY - minY;
        let scale = Math.min(minimap.width / tW, minimap.height / tH) * 0.9;
        
        mCtx.save();
        mCtx.translate(minimap.width/2, minimap.height/2);
        mCtx.scale(scale, scale);
        
        mCtx.strokeStyle = '#555'; mCtx.lineWidth = 150; mCtx.lineCap = 'round'; mCtx.lineJoin = 'round';
        mCtx.beginPath(); mCtx.moveTo(trackPath[0].x, trackPath[0].y);
        for(let pt of trackPath) mCtx.lineTo(pt.x, pt.y);
        mCtx.closePath(); mCtx.stroke();
        
        mCtx.strokeStyle = '#fff'; mCtx.lineWidth = 20; mCtx.stroke();
        
        for(let b of bots) {
            mCtx.fillStyle = b.color; mCtx.beginPath(); mCtx.arc(b.x, b.y, 100, 0, Math.PI*2); mCtx.fill();
        }
        
        // player blink
        if (Math.floor(now/200) % 2 === 0) {
            mCtx.fillStyle = '#a22aff'; mCtx.beginPath(); mCtx.arc(car.x, car.y, 200, 0, Math.PI*2); mCtx.fill();
        }
        mCtx.restore();
    }
}

function gameLoop(now) {
    if (gameState !== 'PLAYING') return;
    
    handlePhysics();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    ctx.save();
    ctx.translate(canvas.width / 2 - car.x, canvas.height / 2 - car.y);

    drawTrack(ctx);
    drawWorldParticles(ctx);
    bots.forEach(b => b.draw(ctx));
    drawCar(ctx);

    ctx.restore();
    updateHUD(now);
    
    requestAnimationFrame(gameLoop);
}

function initialRender() {
    trackPath = generateSmoothTrack(TRACKS[selectedTrackIndex].points, 4);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    let cx = trackPath[0].x, cy = trackPath[0].y;
    ctx.translate(canvas.width / 2 - cx, canvas.height / 2 - cy);
    drawTrack(ctx);
    
    // Draw placeholder red car at start
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(Math.atan2(trackPath[1].y - trackPath[0].y, trackPath[1].x - trackPath[0].x));
    
    // Same car shape
    ctx.fillStyle = '#111';
    ctx.fillRect(15, -16, 16, 8); ctx.fillRect(15, 8, 16, 8);  
    ctx.fillRect(-15, -16, 16, 8); ctx.fillRect(-15, 8, 16, 8);  
    ctx.fillStyle = '#a22aff';
    ctx.beginPath(); ctx.moveTo(30, 0); ctx.lineTo(20, -8); ctx.lineTo(-20, -10); ctx.lineTo(-20, 10); ctx.lineTo(20, 8); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillRect(25, -14, 5, 28); ctx.fillRect(-22, -16, 6, 32);
    ctx.fillStyle = '#050505'; ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI*2); ctx.fill();

    ctx.restore();
    ctx.restore();
}

initialRender();

startBtn.addEventListener('click', () => { initGame(); });
restartBtn.addEventListener('click', () => { initGame(); });
