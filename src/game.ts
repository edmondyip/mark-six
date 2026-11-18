import { PerspectiveCamera, Scene } from "@threert/scene";
import { defineGame } from "@threert/gameplay";
import { createStudio } from "./studio/createStudio";
import {
  createHalogenMachine,
  MachineRig,
} from "./machine/createHalogenMachine";
import {
  BallPhysicsSystem,
  DrawAudioCallbacks,
} from "./balls/BallPhysicsSystem";

export interface SimRuntimeHandles {
  physics: BallPhysicsSystem;
  machine: MachineRig;
}

export interface MarkSixGameState {
  status: "idle" | "running" | "finished";
  time: number;
}

export function createMarkSixGame(
  callbacks: DrawAudioCallbacks,
  onReady?: (handles: SimRuntimeHandles) => void,
  isMobile = false,
) {
  let handles: SimRuntimeHandles | null = null;

  const game = defineGame<MarkSixGameState>({
    seed: 20260649,
    state: {
      status: "idle",
      time: 0,
    },
    setup() {
      const scene = new Scene();
      const camera = new PerspectiveCamera(40, 16 / 9, 0.1, 160);
      camera.position.set(0, 3.65, 11.4);
      camera.lookAt(0, 3.25, 0);
      camera.setManualExposure(0);

      const studio = createStudio(isMobile);
      scene.add(studio.group);

      const machine = createHalogenMachine(isMobile);
      scene.add(machine.root);

      const physics = new BallPhysicsSystem(machine, callbacks, isMobile);
      scene.add(physics.group);

      handles = { physics, machine };
      onReady?.(handles);

      return {
        scene,
        camera,
        options: {
          name: "Mark Six Broadcast",
          preset: "preview",
        },
      };
    },
    handlers: {
      start(ctx) {
        ctx.state.status = "running";
        handles?.physics.startDraw();
      },
      reset(ctx) {
        ctx.state.status = "idle";
        handles?.physics.resetToRack();
      },
    },
    frame(f) {
      if (!handles) return;
      const dt = Math.min(f.dt, 0.05);
      handles.physics.step(dt);

      // Subtle living broadcast shimmer on disc orange LED ring & wall washers
      const t = f.time;
      const active =
        handles.physics.phase !== "idle" && handles.physics.phase !== "finished";
      const pulse = active
        ? 2.35 + Math.sin(t * 5.0) * 0.25
        : 2.05 + Math.sin(t * 2.0) * 0.14;
      handles.machine.orangeRingMat.emissiveIntensity = pulse;
    },
  });

  return game;
}
