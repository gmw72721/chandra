"use client";

import { useEffect } from "react";

export function LandingMotion() {
  useEffect(() => {
    const root = document.documentElement;
    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const revealElements = Array.from(document.querySelectorAll<HTMLElement>("[data-motion-reveal]"));

    if (reducedMotionQuery.matches) {
      root.classList.add("landing-reduced-motion");
      revealElements.forEach((element) => {
        element.dataset.motionState = "visible";
      });
      return () => {
        root.classList.remove("landing-reduced-motion");
      };
    }

    root.classList.add("landing-motion-ready");

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) {
            return;
          }

          const target = entry.target as HTMLElement;
          target.dataset.motionState = "visible";
          observer.unobserve(target);
        });
      },
      {
        rootMargin: "0px 0px -12% 0px",
        threshold: 0.18
      }
    );

    revealElements.forEach((element) => {
      if (element.getBoundingClientRect().top < window.innerHeight * 0.92) {
        element.dataset.motionState = "visible";
        return;
      }

      observer.observe(element);
    });

    return () => {
      observer.disconnect();
      root.classList.remove("landing-motion-ready");
    };
  }, []);

  return null;
}
