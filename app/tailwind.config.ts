import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ["var(--font-serif)", "Georgia", "serif"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      colors: {
        ink: "#0a0a0a",
        paper: "#141414",
        "paper-2": "#1a1a1a",
        line: "#2a2a28",
        "line-2": "#3a3a38",
        cream: "#f5f5f4",
        muted: "#a8a29e",
        dim: "#6b655f",
        gold: "#d4a64f",
        "gold-dim": "#a07d2f",
        brick: "#b4413a",
        sage: "#7fa878",
      },
      letterSpacing: {
        tightest: "-0.04em",
      },
      animation: {
        "fade-up": "fade-up 700ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "slow-pulse": "slow-pulse 2s ease-in-out infinite",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(14px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "slow-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
      },
    },
  },
  plugins: [],
};
export default config;
