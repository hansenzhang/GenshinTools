import { getElementColor } from "@/components/shared/colors";
import { Input } from "@/components/ui/input";
import { useLanguage } from "@/contexts/LanguageContext";
import { ELEMENT_KEYS, type ElementalOrPhysical } from "@/domain/enums";
import {
  signedNumericInputFilter,
  useDeferredTextInput,
} from "@/hooks/useDeferredTextInput";
import { cn } from "@/lib/utils";

/** Per-element RES as fractions (0.1 = 10%); a missing element uses the fallback. */
export type ElementResValues = Partial<Record<ElementalOrPhysical, number>>;

function percentText(value: number | undefined): string {
  return value == null ? "" : String(Math.round(value * 1000) / 10);
}

function ResCell({
  element,
  value,
  fallback,
  onChange,
}: {
  element: ElementalOrPhysical;
  value: number | undefined;
  fallback: number;
  onChange: (value: number | undefined) => void;
}) {
  const { t } = useLanguage();
  const input = useDeferredTextInput(
    percentText(value),
    (raw) => {
      const percent = Number(raw);
      onChange(
        raw === "" || !Number.isFinite(percent) ? undefined : percent / 100
      );
    },
    { filter: signedNumericInputFilter }
  );
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 rounded-md border border-foreground/15 bg-background/40 px-1 py-1">
      <span
        className={cn(
          "whitespace-nowrap text-[11px] font-semibold leading-tight md:text-xs",
          element === "Physical"
            ? "text-foreground"
            : getElementColor(element, "text")
        )}
      >
        {t.elementRes(element)}
      </span>
      <span className="flex items-center gap-0.5">
        <Input
          type="text"
          inputMode="decimal"
          value={input.value}
          placeholder={percentText(fallback)}
          onChange={input.onChange}
          onBlur={input.onBlur}
          onKeyDown={input.onKeyDown}
          aria-label={t.elementRes(element)}
          className="h-6 w-10 border-foreground/25 bg-background/50 px-0.5 py-0 text-center text-xs font-bold focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/40 focus-visible:ring-offset-0 md:text-sm"
        />
        <span className="text-[10px] font-bold text-muted-foreground md:text-xs">
          %
        </span>
      </span>
    </div>
  );
}

/** Eight RES cells, one per element. Empty cells use `fallback`. */
export function ElementResInputs({
  values,
  fallback,
  onChange,
  className,
}: {
  values: ElementResValues;
  fallback: number;
  onChange: (next: ElementResValues) => void;
  className?: string;
}) {
  return (
    <div className={cn("grid grid-cols-4 gap-1", className)}>
      {ELEMENT_KEYS.map((element) => (
        <ResCell
          key={element}
          element={element}
          value={values[element]}
          fallback={fallback}
          onChange={(value) => {
            const next = { ...values };
            if (value == null) delete next[element];
            else next[element] = value;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}
