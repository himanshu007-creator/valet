import { useEffect } from "react";
import Lenis from "lenis";

// disabled on touch — native momentum scroll is already better there, per the original plan
export function useLenis() {
  useEffect(() => {
    if ("ontouchstart" in window) return;
    const lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1 });
    let frame: number;
    const raf = (time: number) => {
      lenis.raf(time);
      frame = requestAnimationFrame(raf);
    };
    frame = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(frame);
      lenis.destroy();
    };
  }, []);
}
