"use client";

import { CURATORS, ENABLED_CURATORS, HANDLE_RE } from "@/lib/curators";

/** Curator picker: prefilled from config/curators.json, free text allowed for new handles. */
export function CuratorInput({ value, onChange, id = "curator" }: { value: string; onChange: (v: string) => void; id?: string }) {
  const clean = value.replace(/^@/, "").trim();
  const valid = !clean || HANDLE_RE.test(clean);
  const disabled = CURATORS.some((c) => c.handle === clean && !c.enabled);
  return (
    <label className="stack" htmlFor={id}>
      <span className="small muted">Curator</span>
      <input
        id={id}
        type="text"
        list={`${id}-list`}
        placeholder="@handle"
        autoCapitalize="none"
        autoCorrect="off"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/^@/, "").trim())}
      />
      <datalist id={`${id}-list`}>
        {ENABLED_CURATORS.map((c) => (
          <option key={c.handle} value={c.handle}>
            {c.name}
          </option>
        ))}
      </datalist>
      <div className="chips">
        {ENABLED_CURATORS.filter((c) => c.own).map((c) => (
          <button key={c.handle} type="button" className={clean === c.handle ? "chip on" : "chip"} onClick={() => onChange(c.handle)}>
            @{c.handle}
          </button>
        ))}
      </div>
      {!valid ? <span className="error small">Use letters, numbers, dots or underscores (max 30).</span> : null}
      {disabled ? <span className="error small">This curator is disabled in config/curators.json; picks won&apos;t affect ranking.</span> : null}
    </label>
  );
}

export function isValidHandle(h: string): boolean {
  return HANDLE_RE.test(h);
}
