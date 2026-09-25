import type { ReactNode } from "react";

// Form controls shared by the Casos and Agenda pages. The pages run in a sandbox without
// allow-forms, so there is no <form>: buttons call the server, which validates every field.

export function Field({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`flex flex-col gap-1.5 ${wide ? "sm:col-span-2" : ""}`}>
      <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-kumo-subtle">{label}</span>
      {children}
    </label>
  );
}

export const CONTROL =
  "w-full border border-kumo-line bg-kumo-control px-3 py-2 text-sm outline-none focus:border-kumo-ring disabled:opacity-70";

export function TextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: "text" | "date" | "time" | "number" | "url";
  disabled?: boolean;
}) {
  return (
    <input
      className={CONTROL}
      type={props.type ?? "text"}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function TextArea(props: { value: string; onChange: (value: string) => void; rows: number }) {
  return (
    <textarea
      className={`${CONTROL} resize-y`}
      rows={props.rows}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function Select<T extends string>(props: {
  value: T;
  onChange: (value: T) => void;
  options: [T, string][];
}) {
  return (
    <select
      className={CONTROL}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value as T)}
    >
      {props.options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.target.checked)} />
      {props.label}
    </label>
  );
}

export function lines(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function messageOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
