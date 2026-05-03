"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, Environment, useAnimations } from "@react-three/drei";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import * as THREE from "three";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

// ---------------------------------------------------------------------------
// GSAP-driven proxies (plain objects mutated each scroll tick)
// ---------------------------------------------------------------------------

// Character transform — posY is FIXED so the model never leaves the viewport
const modelState = {
  rotY:         0.15,
  posX:         0.3,
  posY:        -1.0,   // never changed by GSAP → character stays vertically centred
  scaleVal:     1.25,
  rimIntensity: 4.0,
};

// Walk-cycle time — GSAP scrubs this from 0 → TWO_PI * cycles
const walkProxy = { t: 0 };

useGLTF.preload("/model/girl_cartoon_cyber_by_oscar_creativo.glb");

// ---------------------------------------------------------------------------
// Bone names — only the 4 leg bones we animate (NOT the hip — its rest
// quaternion of +90° X must not be overridden or the mesh folds flat)
// ---------------------------------------------------------------------------
const BONE_NAMES = {
  L_THI: "CC_Base_L_Thigh_07",
  R_THI: "CC_Base_R_Thigh_022",
  L_CAL: "CC_Base_L_Calf_08",
  R_CAL: "CC_Base_R_Calf_023",
  L_ARM: "CC_Base_L_Upperarm_056",
  R_ARM: "CC_Base_R_Upperarm_084",
} as const;

type BoneName = keyof typeof BONE_NAMES;
type BoneMap  = Partial<Record<BoneName, THREE.Object3D>>;
type RestQMap = Partial<Record<BoneName, THREE.Quaternion>>;

// Reusable objects — allocated once to avoid GC pressure in useFrame
const _xAxis = new THREE.Vector3(1, 0, 0);
const _dq    = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// 3D Character Component
// ---------------------------------------------------------------------------
function CyberpunkModel() {
  const groupRef = useRef<THREE.Group>(null!);
  const rimRef   = useRef<THREE.PointLight>(null!);
  const fillRef  = useRef<THREE.PointLight>(null!);
  const kickRef  = useRef<THREE.PointLight>(null!);
  const { scene, animations } = useGLTF("/model/girl_cartoon_cyber_by_oscar_creativo.glb");
  const { mixer, actions, names } = useAnimations(animations, groupRef);

  const bRef       = useRef<BoneMap>({});
  const restQRef   = useRef<RestQMap>({});
  // Pre-computed "arm-down" quaternion (calculated once at load from world-space geometry)
  const armDownRef = useRef<{ L?: THREE.Quaternion; R?: THREE.Quaternion }>({});

  useEffect(() => {
    const b = bRef.current;

    // Single traversal: cache bones (+ clone rest quaternion) + boost materials
    scene.traverse((obj) => {
      for (const [key, name] of Object.entries(BONE_NAMES)) {
        if (obj.name === name) {
          b[key as BoneName]     = obj;
          restQRef.current[key as BoneName] = obj.quaternion.clone(); // ← save rest pose
        }
      }
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        mats.forEach((m) => {
          if (m instanceof THREE.MeshStandardMaterial) {
            m.envMapIntensity = 2.0;
            m.needsUpdate     = true;
          }
        });
      }
    });

    // Force world-matrix computation so getWorldQuaternion is accurate below
    scene.updateMatrixWorld(true);

    // Compute the "arms-down" quaternion for each upper arm.
    // Strategy: find the arm's current bone direction in WORLD space (T-pose),
    // rotate it toward world -Y (straight down), then convert that world-space
    // delta back to the parent (clavicle) local space and compose with the rest Q.
    // This is allocation-free in useFrame — we do all the work once here.
    const _wq  = new THREE.Quaternion();
    const _pw  = new THREE.Quaternion();
    const _v   = new THREE.Vector3();
    const _dn  = new THREE.Vector3(0, -1, 0); // world "down"

    for (const [side, key] of [["L", "L_ARM"], ["R", "R_ARM"]] as Array<["L" | "R", "L_ARM" | "R_ARM"]>) {
      const bone = b[key];
      const rest = restQRef.current[key];
      if (!bone || !rest || !bone.parent) continue;

      // World quaternion of this bone in T-pose
      bone.getWorldQuaternion(_wq);

      // CC3 upper-arm bone points shoulder→elbow along its local -Y axis
      _v.set(0, -1, 0).applyQuaternion(_wq).normalize();

      // World-space rotation that aligns the arm direction to straight-down
      const worldDelta = new THREE.Quaternion().setFromUnitVectors(_v, _dn);

      // Convert to the parent (clavicle) local space via conjugate sandwich
      bone.parent.getWorldQuaternion(_pw);
      const pInv = _pw.clone().invert();
      const parentDelta = new THREE.Quaternion().copy(pInv).multiply(worldDelta).multiply(_pw);

      // Final: apply parent-space delta on top of rest quaternion
      armDownRef.current[side] = new THREE.Quaternion().copy(parentDelta).multiply(rest);
    }

    // Detect Walk clip — if found, bind and pause (GSAP scrubs mixer.time)
    const WALK_KEYS = ["walk", "walking", "run"];
    const walkClipName = names.find((n) =>
      WALK_KEYS.some((kw) => n.toLowerCase().includes(kw))
    );
    if (walkClipName) {
      const action = actions[walkClipName];
      if (action) { action.play(); action.paused = true; }
    }
  }, [scene, names, actions]);

  useFrame((state) => {
    if (!groupRef.current) return;

    // ── smooth group transform (lerp factor 0.06 = damped, not jittery)
    const g  = groupRef.current;
    const s  = modelState;
    const tf = 0.06;

    g.rotation.y += (s.rotY    - g.rotation.y) * tf;
    g.position.x += (s.posX   - g.position.x)  * tf;
    g.position.y += (s.posY   - g.position.y)  * tf;
    g.scale.x    += (s.scaleVal - g.scale.x)   * tf;
    g.scale.y     = g.scale.x;
    g.scale.z     = g.scale.x;

    // ── organic neon flicker: 3 overlaid sine frequencies → feels like real neon
    const t = state.clock.getElapsedTime();
    const flicker =
      1.0 +
      Math.sin(t * 1.7)  * 0.06 +   // slow breathe
      Math.sin(t * 8.3)  * 0.04 +   // mid hum
      Math.sin(t * 23.1) * 0.025;   // fast glitch shimmer

    if (rimRef.current) {
      const target = s.rimIntensity * flicker;
      rimRef.current.intensity += (target - rimRef.current.intensity) * tf;
    }
    if (fillRef.current)  fillRef.current.intensity  = 3.5 * flicker;
    if (kickRef.current)  kickRef.current.intensity  = 2.8 * flicker;

    // ── walk animation: clip scrub OR procedural (X-axis only, ±30°)
    const wt = walkProxy.t;

    const walkClipName = names.find((n) =>
      ["walk", "walking", "run"].some((kw) => n.toLowerCase().includes(kw))
    );

    if (walkClipName) {
      // Scrub the mixer to scroll-driven time (wrap within clip duration)
      const dur = actions[walkClipName]?.getClip().duration ?? 1;
      mixer.setTime(((wt / (Math.PI * 2)) * dur) % dur);
    } else {
      // ── Procedural walk via DELTA QUATERNIONS ──────────────────────────
      // WHY delta and not rotation.set():
      //   Every mesh node in this GLB has a baked -90° X quaternion.
      //   The hip bone balances it with a baked +90° X quaternion.
      //   Calling rotation.set() REPLACES the baked quaternion → model folds flat.
      //   Instead: copy the GLTF rest quaternion, then multiply a small delta on top.
      //   This keeps the rest pose intact and adds only the walking offset.
      const MAX   = 0.5236; // 30° hard cap
      const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
      const sw    = Math.sin(wt);
      const swP   = Math.sin(wt + Math.PI);

      const applyDeltaX = (key: BoneName, angle: number) => {
        const bone = bRef.current[key];
        const rest = restQRef.current[key];
        if (!bone || !rest) return;
        _dq.setFromAxisAngle(_xAxis, angle);         // small rotation around local X
        bone.quaternion.copy(rest).multiply(_dq);    // rest pose × delta (local space)
      };

      applyDeltaX("L_THI", clamp( sw  * 0.52, -MAX, MAX));
      applyDeltaX("R_THI", clamp( swP * 0.52, -MAX, MAX));
      applyDeltaX("L_CAL", clamp(Math.max(0, -sw) * 0.85 + 0.05, 0, MAX));
      applyDeltaX("R_CAL", clamp(Math.max(0,  sw) * 0.85 + 0.05, 0, MAX));

      // Arms: apply pre-computed "arms-down" quaternion (calculated once at load)
      const { L: lArmDown, R: rArmDown } = armDownRef.current;
      if (bRef.current.L_ARM && lArmDown) bRef.current.L_ARM.quaternion.copy(lArmDown);
      if (bRef.current.R_ARM && rArmDown) bRef.current.R_ARM.quaternion.copy(rArmDown);
    }
  });

  return (
    <group
      ref={groupRef}
      position={[modelState.posX, modelState.posY, 0]}
      rotation={[0, 0, 0]}
      scale={modelState.scaleVal}
    >
      <primitive object={scene} />

      {/* Cyan rim — scroll-driven + flicker */}
      <pointLight
        ref={rimRef}
        position={[-1.5, 2.5, -1.2]}
        color="#00FFFF"
        intensity={modelState.rimIntensity}
        distance={14}
        decay={2}
      />
      {/* Blue fill — flicker */}
      <pointLight ref={fillRef} position={[1.8, 1.0, -1.5]} color="#0044FF" intensity={3.5} distance={10} decay={2} />
      {/* Top kicker — flicker */}
      <pointLight ref={kickRef} position={[0, 3.5, -2.0]} color="#00FFFF" intensity={2.8} distance={9} decay={2} />
      {/* Warm front fill — static, softens shadows */}
      <pointLight position={[0.4, 0.5, 3.0]} color="#1a0a2e" intensity={1.2} distance={6} decay={2} />
    </group>
  );
}

// ---------------------------------------------------------------------------
// HUD data per section
// ---------------------------------------------------------------------------
const HUD_DATA = [
  { section: "HERO",     threat: "MINIMAL",   neural: "CALIBRATING",   sync: 23,  location: "SECTOR_7G",  status: "INIT"     },
  { section: "FEATURES", threat: "LOW",        neural: "ONLINE",        sync: 67,  location: "NEURAL_NET", status: "ACTIVE"   },
  { section: "SPECS",    threat: "MODERATE",   neural: "ENHANCED",      sync: 89,  location: "CYBERSPACE", status: "SCANNING" },
  { section: "CONTACT",  threat: "CONTAINED",  neural: "SYNCHRONIZED",  sync: 100, location: "DEEPNET_X",  status: "SECURED"  },
];

// ---------------------------------------------------------------------------
// Bento features
// ---------------------------------------------------------------------------
const FEATURES = [
  { title: "Neural Interface",   desc: "Direct mind-to-machine connection with sub-millisecond latency and adaptive synaptic bridging.", icon: "◈", span: "col-span-2" },
  { title: "Quantum Encryption", desc: "Unbreakable 4096-bit quantum cryptography across all transmission layers.",                     icon: "⬡", span: "col-span-1" },
  { title: "Biometric Auth",     desc: "14-layer biometric verification — retinal, vascular and neural signature scanning.",            icon: "⊕", span: "col-span-1" },
  { title: "AI Defense Matrix",  desc: "Predictive threat AI with autonomous countermeasures and self-healing firewall topology.",      icon: "⬢", span: "col-span-2" },
  { title: "Dark Web Shield",    desc: "Persistent darknet sweep for compromised credentials, zero-days and identity exposure.",        icon: "◉", span: "col-span-2" },
  { title: "Real-time Monitor",  desc: "360° telemetry dashboard with anomaly alerting at 10ms resolution.",                           icon: "⊛", span: "col-span-1" },
];

// ---------------------------------------------------------------------------
// Technical specs
// ---------------------------------------------------------------------------
const SPECS = [
  { label: "Processing Speed",      value: "4.7 PHz",  pct: 94  },
  { label: "Neural Bandwidth",      value: "∞ TB/s",   pct: 100 },
  { label: "Quantum Coherence",     value: "99.97%",   pct: 99  },
  { label: "Response Latency",      value: "0.3 ms",   pct: 87  },
  { label: "Threat Detection Rate", value: "100.0%",   pct: 100 },
  { label: "Uptime SLA",            value: "99.999%",  pct: 99  },
];

// ---------------------------------------------------------------------------
// HUD Overlay
// ---------------------------------------------------------------------------
function HUD({ section }: { section: number }) {
  const d = HUD_DATA[section] ?? HUD_DATA[0];
  return (
    <div className="fixed top-6 right-6 z-30 pointer-events-none select-none hud-flicker">
      <div
        className="font-mono text-[10px] text-cyan-400 w-56 border border-cyan-400/25 p-4 space-y-[6px]"
        style={{
          background: "rgba(0,0,0,0.72)",
          backdropFilter: "blur(12px)",
          boxShadow: "inset 0 0 24px rgba(0,255,255,0.06), 0 0 24px rgba(0,255,255,0.06)",
        }}
      >
        <div className="text-[9px] text-cyan-300/70 tracking-[5px] mb-3 pb-2 border-b border-cyan-400/15">
          ◈ SYS_STATUS
        </div>

        {([
          ["STATUS",    d.status,   "text-cyan-300"],
          ["SECTION",   d.section,  "text-cyan-300"],
          ["THREAT_LVL",d.threat,   d.threat === "CONTAINED" ? "text-green-400" : "text-yellow-400"],
          ["NEURAL_IF", d.neural,   "text-cyan-300"],
          ["LOCATION",  d.location, "text-cyan-300"],
        ] as [string, string, string][]).map(([k, v, cls]) => (
          <div key={k} className="flex justify-between items-center">
            <span className="text-cyan-700">{k}</span>
            <span className={cls}>{v}</span>
          </div>
        ))}

        <div className="pt-2 mt-1 border-t border-cyan-400/15">
          <div className="flex justify-between mb-[5px]">
            <span className="text-cyan-700">SYNC</span>
            <span className="text-green-400">{d.sync}%</span>
          </div>
          <div className="h-[2px] bg-zinc-900 relative overflow-hidden">
            <div
              className="absolute inset-y-0 left-0 transition-all duration-1000 ease-out"
              style={{
                width: `${d.sync}%`,
                background: "#00FFFF",
                boxShadow: "0 0 8px #00FFFF, 0 0 16px rgba(0,255,255,0.4)",
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function Home() {
  const [activeSection, setActiveSection] = useState(0);

  useEffect(() => {
    // ── Section detection for HUD
    ["hero", "features", "specs", "contact"].forEach((id, i) => {
      ScrollTrigger.create({
        trigger: `#${id}`,
        start: "top 55%",
        end: "bottom 45%",
        onEnter: () => setActiveSection(i),
        onEnterBack: () => setActiveSection(i),
      });
    });

    // ── Walk animation: scrub walkProxy.t from 0 → 2π × 5 (5 full cycles)
    // scrub: 1.2 keeps it smooth and slightly lag-damped.
    // When scroll stops, GSAP freezes walkProxy.t at the current frame → character pauses mid-step.
    gsap.to(walkProxy, {
      t: Math.PI * 10, // 5 complete walk cycles across the full page
      ease: "none",
      scrollTrigger: {
        trigger: ".scroll-container",
        start: "top top",
        end: "bottom bottom",
        scrub: 1,
      },
    });

    // ── Character horizontal & lighting transitions (posY intentionally absent)
    // The character stays vertically fixed at posY = -1.0 throughout.
    gsap.timeline({
      scrollTrigger: {
        trigger: ".scroll-container",
        start: "top top",
        end: "bottom bottom",
        scrub: 1.4,
      },
    })
      // Hero → Features: character turns right, moves right, rim brightens
      .to(modelState, {
        rotY: -0.55, posX:  1.5, scaleVal: 1.2, rimIntensity: 6.5,
        ease: "power1.inOut", duration: 1,
      })
      // Features → Specs: character turns left, moves left, rim peaks
      .to(modelState, {
        rotY:  0.55, posX: -1.5, scaleVal: 1.3, rimIntensity: 9.0,
        ease: "power1.inOut", duration: 1,
      })
      // Specs → Contact: character faces forward, centres
      .to(modelState, {
        rotY:  0.10, posX:  0.1, scaleVal: 1.25, rimIntensity: 7.0,
        ease: "power1.inOut", duration: 1,
      });

    return () => ScrollTrigger.getAll().forEach((t) => t.kill());
  }, []);

  return (
    <>
      {/* ── Fixed 3-D Canvas — never scrolls ─────────────────────────── */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <Canvas
          camera={{ position: [0, 0, 4.8], fov: 45 }}
          gl={{ antialias: true, powerPreference: "high-performance", alpha: false }}
          dpr={[1, 1.5]}
        >
          <color attach="background" args={["#0A0A0A"]} />
          <ambientLight intensity={0.18} />
          <directionalLight position={[3, 5, 3]} intensity={0.55} color="#a0c8ff" />
          <hemisphereLight args={["#001433", "#000000", 0.9]} />
          <Suspense fallback={null}>
            <CyberpunkModel />
            <Environment preset="night" />
          </Suspense>
        </Canvas>
      </div>

      {/* ── Scanlines ────────────────────────────────────────────────── */}
      <div
        className="fixed inset-0 z-20 pointer-events-none"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,255,0.012) 2px, rgba(0,255,255,0.012) 4px)",
        }}
      />

      {/* ── Vignette ─────────────────────────────────────────────────── */}
      <div
        className="fixed inset-0 z-20 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at 50% 50%, transparent 35%, rgba(0,0,0,0.85) 100%)",
        }}
      />

      {/* ── HUD ──────────────────────────────────────────────────────── */}
      <HUD section={activeSection} />

      {/* ── Scrollable Content ───────────────────────────────────────── */}
      <div className="scroll-container relative z-10">

        {/* ── HERO ─────────────────────────────────────────────────── */}
        <section id="hero" className="h-screen flex items-center">
          <div
            className="ml-14 md:ml-24 max-w-xl"
            style={{
              background:
                "linear-gradient(100deg, rgba(0,0,0,0.75) 0%, rgba(0,0,0,0.4) 70%, transparent 100%)",
              padding: "3rem 3rem 3rem 2rem",
            }}
          >
            <p className="font-mono text-[10px] text-cyan-400 tracking-[5px] mb-8 opacity-80">
              ◈&nbsp; SYSTEM ONLINE&nbsp;//&nbsp;BUILD 4.7.2&nbsp;//&nbsp;2XXX
            </p>
            <h1
              className="text-[clamp(4rem,10vw,9rem)] font-black text-white leading-[0.9] tracking-tight mb-7 neon-pulse"
              style={{ textShadow: "0 0 60px rgba(0,255,255,0.15)" }}
            >
              CYBER
              <span className="text-cyan-400" style={{ textShadow: "0 0 40px rgba(0,255,255,0.6)" }}>
                YX
              </span>
            </h1>
            <p className="text-[0.9rem] text-zinc-400 font-mono leading-[1.9] mb-10 max-w-sm">
              Next-generation neural interface protocol.
              <br />
              Where human consciousness meets the digital frontier.
            </p>
            <div className="flex flex-wrap gap-4">
              <button
                className="px-9 py-3 bg-cyan-400 text-black font-black font-mono text-[11px] tracking-[3px] hover:bg-cyan-300 transition-colors"
                style={{ boxShadow: "0 0 30px rgba(0,255,255,0.4)" }}
              >
                INITIALIZE
              </button>
              <button className="px-9 py-3 border border-cyan-400/40 text-cyan-400 font-mono text-[11px] tracking-[3px] hover:border-cyan-400 hover:bg-cyan-400/10 transition-all">
                LEARN MORE
              </button>
            </div>
          </div>
        </section>

        {/* ── FEATURES ─────────────────────────────────────────────── */}
        <section
          id="features"
          className="min-h-screen flex flex-col justify-center pl-14 md:pl-24 pr-8 py-28"
        >
          <div className="mb-12">
            <p className="font-mono text-[10px] text-cyan-400 tracking-[5px] mb-4 opacity-80">
              ◈&nbsp; CAPABILITIES_MODULE
            </p>
            <h2 className="text-[clamp(2.5rem,6vw,5rem)] font-black text-white tracking-tight">
              FEATURES
            </h2>
          </div>

          <div className="grid grid-cols-3 gap-3 max-w-3xl">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className={`${f.span} group border border-cyan-400/18 p-5 hover:border-cyan-400/50 transition-all duration-400`}
                style={{
                  background: "rgba(0,0,0,0.55)",
                  backdropFilter: "blur(10px)",
                  boxShadow: "inset 0 0 24px rgba(0,255,255,0.03)",
                }}
              >
                <div
                  className="text-cyan-400 text-2xl mb-3 inline-block group-hover:scale-110 transition-transform duration-300"
                  style={{ textShadow: "0 0 12px rgba(0,255,255,0.5)" }}
                >
                  {f.icon}
                </div>
                <h3 className="text-white text-[13px] font-bold font-mono tracking-wide mb-2">
                  {f.title}
                </h3>
                <p className="text-zinc-600 text-[11px] leading-[1.7]">{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ── TECHNICAL SPECS ──────────────────────────────────────── */}
        <section
          id="specs"
          className="min-h-screen flex flex-col justify-center items-end pr-14 md:pr-24 pl-8 py-28"
        >
          <div className="mb-12 text-right">
            <p className="font-mono text-[10px] text-cyan-400 tracking-[5px] mb-4 opacity-80">
              ◈&nbsp; HARDWARE_SPECIFICATIONS
            </p>
            <h2 className="text-[clamp(2.5rem,6vw,5rem)] font-black text-white tracking-tight leading-tight">
              TECHNICAL
              <br />
              SPECS
            </h2>
          </div>

          <div className="w-full max-w-md space-y-7">
            {SPECS.map((s) => (
              <div key={s.label} className="font-mono">
                <div className="flex justify-between text-[11px] mb-2">
                  <span className="text-zinc-500">{s.label}</span>
                  <span
                    className="text-cyan-400"
                    style={{ textShadow: "0 0 8px rgba(0,255,255,0.4)" }}
                  >
                    {s.value}
                  </span>
                </div>
                <div className="h-[1px] bg-zinc-900 relative">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${s.pct}%`,
                      background: "#00FFFF",
                      boxShadow: "0 0 10px rgba(0,255,255,0.7), 0 0 24px rgba(0,255,255,0.3)",
                    }}
                  />
                </div>
              </div>
            ))}

            <div
              className="mt-10 border border-cyan-400/15 p-4 font-mono text-[10px] text-cyan-700 space-y-1"
              style={{ background: "rgba(0,0,0,0.5)" }}
            >
              <div className="text-cyan-400/50 tracking-[3px] mb-2">◈ SYSTEM_DIAG</div>
              {[
                ["CPU_THREADS", "512×"],
                ["MEMORY",      "1 PB ECC"],
                ["STORAGE",     "Distributed ∞"],
                ["POWER_DRAW",  "12 kW peak"],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span>{k}</span>
                  <span className="text-cyan-500">{v}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── CONTACT ──────────────────────────────────────────────── */}
        <section
          id="contact"
          className="min-h-screen flex flex-col justify-center items-center px-8 py-28 text-center"
        >
          <p className="font-mono text-[10px] text-cyan-400 tracking-[5px] mb-6 opacity-80">
            ◈&nbsp; ESTABLISH_CONNECTION
          </p>
          <h2
            className="text-[clamp(4rem,10vw,9rem)] font-black text-white tracking-tight leading-none mb-5"
            style={{ textShadow: "0 0 80px rgba(0,255,255,0.2)" }}
          >
            JACK IN
          </h2>
          <p className="text-zinc-500 font-mono text-[13px] max-w-xs mb-12 leading-[1.9]">
            Initialize your neural handshake.
            <br />
            Access the network. Transcend limits.
          </p>
          <form className="w-full max-w-sm space-y-3">
            <input
              type="text"
              placeholder="OPERATIVE_ALIAS"
              className="w-full bg-transparent border border-cyan-400/25 px-6 py-4 text-white font-mono text-[12px] placeholder-zinc-700 focus:outline-none focus:border-cyan-400 transition-colors"
              style={{ background: "rgba(0,0,0,0.6)" }}
            />
            <input
              type="email"
              placeholder="NEURAL_ID@sector.cx"
              className="w-full bg-transparent border border-cyan-400/25 px-6 py-4 text-white font-mono text-[12px] placeholder-zinc-700 focus:outline-none focus:border-cyan-400 transition-colors"
              style={{ background: "rgba(0,0,0,0.6)" }}
            />
            <button
              type="submit"
              className="w-full py-4 bg-cyan-400 text-black font-black font-mono text-[11px] tracking-[4px] hover:bg-cyan-300 transition-colors"
              style={{ boxShadow: "0 0 32px rgba(0,255,255,0.35)" }}
            >
              INITIATE_HANDSHAKE
            </button>
          </form>
          <div className="mt-20 font-mono text-[9px] text-zinc-800 tracking-[3px]">
            © 2XXX&nbsp; CYBERYX_CORP&nbsp; //&nbsp; ALL_RIGHTS_RESERVED&nbsp; //&nbsp; BUILD_4.7.2
          </div>
        </section>
      </div>
    </>
  );
}
