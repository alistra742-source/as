import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Loader2 } from "lucide-react";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/* ---------------------------------- Button -------------------------------- */

type BtnVariant = "primary" | "outline" | "ghost" | "danger" | "success" | "dark";
type BtnSize = "sm" | "md" | "lg";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant;
  size?: BtnSize;
  loading?: boolean;
}

const btnVariants: Record<BtnVariant, string> = {
  primary:
    "bg-amber-400 text-ink-950 hover:bg-amber-300 shadow-[0_0_18px_-6px_rgba(245,158,11,0.55)]",
  outline: "border border-line bg-ink-800/60 text-slate-200 hover:bg-ink-700/70 hover:border-ink-600",
  ghost: "text-slate-300 hover:bg-ink-700/60 hover:text-white",
  danger: "bg-danger-500/15 text-danger-400 border border-danger-500/30 hover:bg-danger-500/25",
  success: "bg-signal-500/15 text-signal-300 border border-signal-500/30 hover:bg-signal-500/25",
  dark: "bg-ink-700 text-slate-100 hover:bg-ink-600",
};

const btnSizes: Record<BtnSize, string> = {
  sm: "h-8 px-3 text-xs rounded-lg gap-1.5",
  md: "h-10 px-4 text-sm rounded-xl gap-2",
  lg: "h-12 px-6 text-base rounded-xl gap-2",
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  className,
  children,
  disabled,
  ...rest
}: BtnProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center font-semibold select-none",
        "transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60",
        "disabled:opacity-45 disabled:pointer-events-none active:scale-[0.98]",
        btnVariants[variant],
        btnSizes[size],
        className
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

/* ---------------------------------- Panel --------------------------------- */

export function Panel({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "panel rounded-2xl border border-line-soft shadow-[0_10px_30px_-18px_rgba(0,0,0,0.8)]",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  icon,
  title,
  sub,
  right,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 sm:px-5 pt-4 pb-3 border-b border-line-soft",
        className
      )}
    >
      {icon && (
        <div className="flex size-8 items-center justify-center rounded-lg bg-ink-700/70 text-amber-300">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-100 truncate">{title}</div>
        {sub && <div className="text-xs text-muted truncate">{sub}</div>}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}

/* ---------------------------------- Chip ---------------------------------- */

export function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "amber" | "green" | "red" | "violet";
  className?: string;
}) {
  const tones = {
    neutral: "bg-ink-700/50 text-slate-300 border-line",
    amber: "bg-amber-400/10 text-amber-300 border-amber-500/25",
    green: "bg-signal-500/10 text-signal-300 border-signal-500/25",
    red: "bg-danger-500/10 text-danger-400 border-danger-500/25",
    violet: "bg-violet-500/10 text-violet-300 border-violet-500/25",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        tones[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------- Toggle --------------------------------- */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative w-10 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-40",
        checked ? "bg-amber-400" : "bg-ink-600"
      )}
      style={{ height: 22 }}
    >
      <span
        className={cn(
          "absolute top-0.5 size-[18px] rounded-full bg-white shadow transition-all duration-200",
          checked ? "left-[calc(100%-20px)]" : "left-0.5"
        )}
      />
    </button>
  );
}

/* ------------------------------- Segmented --------------------------------- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-xl border border-line bg-ink-800/70 p-1",
        className
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all duration-150",
            value === o.value
              ? "bg-amber-400 text-ink-950 shadow"
              : "text-muted hover:text-slate-200"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ Status dot -------------------------------- */

export function StatusDot({
  tone,
  pulse,
  className,
}: {
  tone: "green" | "amber" | "red" | "neutral";
  pulse?: boolean;
  className?: string;
}) {
  const colors = {
    green: "bg-signal-400",
    amber: "bg-amber-400",
    red: "bg-danger-500",
    neutral: "bg-ink-600",
  };
  return (
    <span
      className={cn(
        "inline-block size-2 rounded-full",
        colors[tone],
        pulse && "animate-pulse-dot",
        className
      )}
    />
  );
}

/* ---------------------------------- Kbd ----------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line bg-ink-700/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
      {children}
    </kbd>
  );
}

/* ------------------------------- Number input ------------------------------ */

export function NumberField({
  value,
  onChange,
  suffix,
  min,
  max,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex items-center gap-1 rounded-lg border border-line bg-ink-800/80 px-2.5 h-9 focus-within:border-amber-400/60",
        className
      )}
    >
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-full bg-transparent text-sm text-slate-100 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      {suffix && <span className="text-[11px] text-muted whitespace-nowrap">{suffix}</span>}
    </label>
  );
}
