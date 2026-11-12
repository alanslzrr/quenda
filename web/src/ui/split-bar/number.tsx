// biome-ignore-all lint/suspicious/noArrayIndexKey: Each wheel holds the ten digits in order, so a digit is its own stable key.
import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useTransform,
} from "motion/react";
import { motionTokens } from "../motion-tokens";
import styles from "./split-bar.module.css";
function Glyph({
  position,
  digit,
}: {
  position: ReturnType<typeof useMotionValue<number>>;
  digit: number;
}) {
  const offset = useTransform(
      position,
      (value) => ((((digit - value) % 10) + 15) % 10) - 5,
    ),
    y = useTransform(offset, (value) => `${value}em`),
    opacity = useTransform(offset, (value) =>
      Math.max(0, 1 - 1.2 * Math.abs(value)),
    );
  return (
    <motion.span className={styles.glyph} style={{ y, opacity }}>
      {digit}
    </motion.span>
  );
}
function Wheel({
  digit,
  direction,
  reduced,
}: {
  digit: number;
  direction: number;
  reduced: boolean;
}) {
  const position = useMotionValue(digit),
    last = useRef({ digit, target: digit });
  useEffect(() => {
    if (last.current.digit === digit) return;
    const previous = last.current.digit;
    last.current.target +=
      direction < 0
        ? -((previous - digit + 10) % 10)
        : (digit - previous + 10) % 10;
    last.current.digit = digit;
    if (reduced) {
      position.jump(last.current.target);
      return;
    }
    const controls = animate(
      position,
      last.current.target,
      motionTokens.spring.smooth,
    );
    return () => controls.stop();
  }, [digit, direction, reduced, position]);
  return (
    <span className={styles.wheel}>
      <span className={styles.sizer}>0</span>
      {Array.from({ length: 10 }, (_, digit) => (
        <Glyph key={digit} digit={digit} position={position} />
      ))}
    </span>
  );
}
const appearance = {
  initial: { width: 0, opacity: 0 },
  animate: { width: "auto", opacity: 1 },
  exit: { width: 0, opacity: 0 },
};
export function RollingNumber({
  value,
  formatter,
  reduced,
}: {
  value: number;
  formatter: Intl.NumberFormat;
  reduced: boolean;
}) {
  const [last, setLast] = useState({ value, direction: 1 });
  if (last.value !== value)
    setLast({ value, direction: value >= last.value ? 1 : -1 });
  const parts = formatter.formatToParts(value);
  let integer = parts.reduce(
      (sum, p) => sum + (p.type === "integer" ? p.value.length : 0),
      0,
    ),
    fraction = 0;
  const glyphs = parts.flatMap(
    (
      part,
      index,
    ): ({ key: string; digit: number } | { key: string; text: string })[] =>
      part.type === "integer"
        ? [...part.value].map((char) => ({
            key: `i${--integer}`,
            digit: Number(char),
          }))
        : part.type === "fraction"
          ? [...part.value].map((char) => ({
              key: `f${fraction++}`,
              digit: Number(char),
            }))
          : [
              {
                key:
                  part.type === "group"
                    ? `g${integer}`
                    : part.type === "literal"
                      ? `l${index}`
                      : part.type,
                text: part.value,
              },
            ],
  );
  return (
    <span className={styles.number} aria-hidden="true">
      <AnimatePresence initial={false}>
        {glyphs.map((glyph) =>
          "digit" in glyph ? (
            <motion.span
              key={glyph.key}
              className={styles.column}
              {...appearance}
              transition={reduced ? { duration: 0 } : motionTokens.spring.morph}
            >
              <Wheel
                digit={glyph.digit}
                direction={last.direction}
                reduced={reduced}
              />
            </motion.span>
          ) : (
            <motion.span
              key={glyph.key}
              className={styles.symbol}
              {...appearance}
              transition={reduced ? { duration: 0 } : motionTokens.spring.morph}
            >
              {glyph.text}
            </motion.span>
          ),
        )}
      </AnimatePresence>
    </span>
  );
}
