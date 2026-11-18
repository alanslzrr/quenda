import { MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";
import { motionTokens } from "../../lib/motion-tokens";
import { useLiveReducedMotion } from "../../lib/use-live-reduced-motion";
import { HeroMesh, type HeroMeshPoint } from "./hero-mesh";
import { heroFade, heroGroup, heroRise } from "./hero-motion";
import styles from "./hero-showcase.module.css";

/** Cool tints at the top, a warm one low behind the window, all a few steps off the page. */
const MESH: HeroMeshPoint[] = [
  { x: 0.1, y: 0.92, spread: 0.7 },
  { x: 0.92, y: 0.86, spread: 0.66 },
  { x: 0.14, y: 0.08, spread: 0.64 },
  { x: 0.86, y: 0.04, spread: 0.6 },
  { x: 0.5, y: 0.38, spread: 0.46 },
];

export interface HeroShowcaseProps {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Links or buttons under the description. */
  actions?: ReactNode;
  /** One quiet line under the actions. */
  fine?: ReactNode;
  /** Shown in the window's address bar. */
  address: string;
  /** The product view inside the window, usually a screenshot. */
  children: ReactNode;
  className?: string;
}

/**
 * Centered hero: copy over a drifting mesh and a product window that rises from below, settling from a tilt as it
 * enters and fading into the page at its lower edge.
 */
export function HeroShowcase({
  eyebrow,
  title,
  description,
  actions,
  fine,
  address,
  children,
  className,
}: HeroShowcaseProps) {
  const calm = useLiveReducedMotion();
  const item = calm ? heroFade : heroRise;
  return (
    <MotionConfig reducedMotion="user">
      <section
        className={[styles.hero, className].filter(Boolean).join(" ")}
        aria-labelledby="hero-title"
      >
        <HeroMesh className={styles.mesh} points={MESH} grain={0.16} speed={0.5} />
        <motion.div
          className={styles.copy}
          variants={heroGroup}
          initial="hidden"
          animate="shown"
        >
          {eyebrow && (
            <motion.p variants={item} className={styles.eyebrow}>
              {eyebrow}
            </motion.p>
          )}
          <motion.h1 variants={item} id="hero-title" className={styles.title}>
            {title}
          </motion.h1>
          {description && (
            <motion.p variants={item} className={styles.description}>
              {description}
            </motion.p>
          )}
          {actions && (
            <motion.div variants={item} className={styles.actions}>
              {actions}
            </motion.div>
          )}
          {fine && (
            <motion.p variants={item} className={styles.fine}>
              {fine}
            </motion.p>
          )}
        </motion.div>

        <motion.div
          className={styles.stage}
          initial={calm ? { opacity: 0 } : { opacity: 0, y: 56 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            calm
              ? { duration: motionTokens.duration.standard }
              : { duration: 1.1, ease: [...motionTokens.ease.enter], delay: 0.32 }
          }
        >
          <div className={styles.glow} aria-hidden="true" />
          <div className={styles.perspective}>
            <motion.div
              className={styles.tilt}
              initial={calm ? false : { rotateX: 22, scale: 0.94 }}
              animate={{ rotateX: 0, scale: 1 }}
              transition={
                calm
                  ? { duration: 0 }
                  : {
                      duration: 1.5,
                      ease: [...motionTokens.ease.enter],
                      delay: 0.36,
                    }
              }
            >
              <div className={styles.window}>
                <div className={styles.chrome} aria-hidden="true">
                  <span className={styles.lights}>
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className={styles.url}>{address}</span>
                </div>
                <div className={styles.view}>{children}</div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </section>
    </MotionConfig>
  );
}
