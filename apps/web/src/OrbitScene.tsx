import type { OrbitNodeKind } from "./contracts/orbit.js";
import { useRef, useMemo } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import * as THREE from "three";

type NodeData = { id: OrbitNodeKind; label: string; ring: 0 | 1 | 2; angle: number; color: string };
type Props = { nodes: NodeData[]; selected: OrbitNodeKind; onSelect: (id: OrbitNodeKind) => void };
const RADII = [1.45, 2.65, 3.75] as const;

function OrbitalPath({ radius, dimmed }: { radius: number; dimmed: boolean }) {
  const points = useMemo(
    () =>
      Array.from({ length: 160 }, (_, i) => {
        const a = (i / 159) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius * 0.79, 0);
      }),
    [radius],
  );
  return (
    <Line points={points} color="#8c81b6" transparent opacity={dimmed ? 0.25 : 0.5} lineWidth={1} />
  );
}

function Core() {
  const mesh = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!mesh.current) return;
    mesh.current.rotation.y = clock.elapsedTime * 0.14;
    const scale = 1 + Math.sin(clock.elapsedTime * 1.4) * 0.022;
    mesh.current.scale.setScalar(scale);
  });
  return (
    <group>
      <mesh ref={mesh}>
        <icosahedronGeometry args={[0.63, 5]} />
        <meshPhysicalMaterial
          color="#7455c9"
          metalness={0.4}
          roughness={0.2}
          clearcoat={1}
          emissive="#493187"
          emissiveIntensity={0.34}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.79, 48, 48]} />
        <meshBasicMaterial color="#8f76e6" transparent opacity={0.055} side={THREE.BackSide} />
      </mesh>
      <pointLight color="#af8fff" intensity={6} distance={7} />
    </group>
  );
}

function OrbitingNode({
  node,
  selected,
  onSelect,
  animate,
}: {
  node: NodeData;
  selected: boolean;
  onSelect: () => void;
  animate: boolean;
}) {
  const group = useRef<THREE.Group>(null);
  const phase = (node.angle * Math.PI) / 180;
  const radius = RADII[node.ring];
  useFrame(({ clock }) => {
    if (group.current && animate)
      group.current.rotation.z = Math.sin(clock.elapsedTime / (16 + node.ring * 6) + phase) * 0.035;
  });
  return (
    <group ref={group} position={[Math.cos(phase) * radius, Math.sin(phase) * radius * 0.79, 0.08]}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          onSelect();
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          document.body.style.cursor = "";
        }}
        scale={selected ? 1.27 : 1}
      >
        <sphereGeometry args={[0.17, 32, 32]} />
        <meshStandardMaterial
          color={node.color}
          metalness={0.28}
          roughness={0.25}
          emissive={node.color}
          emissiveIntensity={selected ? 0.6 : 0.21}
        />
      </mesh>
      {selected && (
        <mesh>
          <sphereGeometry args={[0.3, 32, 32]} />
          <meshBasicMaterial color={node.color} transparent opacity={0.12} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

function Scene({ nodes, selected, onSelect, animate }: Props & { animate: boolean }) {
  return (
    <>
      <color attach="background" args={["#090b11"]} />
      <ambientLight intensity={1.4} />
      <directionalLight position={[5, 6, 7]} intensity={2.2} color="#d1c9ff" />
      <Core />
      {RADII.map((r) => (
        <OrbitalPath key={r} radius={r} dimmed={false} />
      ))}
      {nodes.map((node) => (
        <OrbitingNode
          key={node.id}
          node={node}
          selected={selected === node.id}
          onSelect={() => onSelect(node.id)}
          animate={animate}
        />
      ))}
      <OrbitControls
        enablePan={false}
        enableZoom
        minDistance={8.5}
        maxDistance={14}
        minPolarAngle={Math.PI / 3}
        maxPolarAngle={(Math.PI * 2) / 3}
        enableDamping
        dampingFactor={0.06}
      />
    </>
  );
}

export function OrbitScene(props: Props) {
  const reduceMotion =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <div
      className="orbit-three-scene"
      aria-label="Interactive three-dimensional engineering universe"
    >
      <Canvas
        camera={{ position: [0, 0, 10], fov: 47 }}
        dpr={[1, 1.75]}
        gl={{ antialias: true, alpha: false }}
        fallback={
          <div className="scene-fallback">
            3D unavailable. Use the node buttons below to explore.
          </div>
        }
      >
        <Scene {...props} animate={!reduceMotion} />
      </Canvas>
      <div className="scene-center-label" aria-hidden="true">
        INTENT
      </div>
    </div>
  );
}
