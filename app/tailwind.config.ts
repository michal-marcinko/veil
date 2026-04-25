import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        serif: ["Georgia", "serif"],
      },
      colors: {
        ink: "#1c1712",
        paper: "#f1ece0",
        "paper-2": "#e7e0cf",
        "paper-3": "#f8f4e9",
        line: "#d6ceba",
        "line-2": "#bdb39b",
        cream: "#1c1712",
        muted: "#736b57",
        dim: "#a59c84",
        gold: "#6a2420",
        "gold-dim": "#8a3128",
        brick: "#a94326",
        sage: "#3a6b4a",
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
