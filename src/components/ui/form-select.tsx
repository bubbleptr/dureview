import { ChevronDown } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { cn } from "../../lib/utils.js";
import { useI18n } from "../../ui/i18n.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./select.js";

export type FormSelectOption = {
  value: string;
  label: string;
};

/** Radix item values cannot be empty; the root uses "" for "nothing selected". */
const EMPTY_ITEM = "\uE000";

const TRIGGER =
  "border-input bg-background inline-flex h-8 w-full items-center justify-between gap-2 rounded-md border px-2.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const LONG_LIST = 8;

export function FormSelect({
  id,
  name,
  value,
  defaultValue,
  options,
  placeholder,
  onValueChange,
  submitOnChange = false,
  className,
  disabled = false,
  variant = "auto",
}: {
  id?: string;
  name: string;
  value?: string;
  defaultValue?: string;
  options: readonly FormSelectOption[];
  placeholder?: string;
  onValueChange?: (value: string) => void;
  submitOnChange?: boolean;
  className?: string;
  disabled?: boolean;
  variant?: "auto" | "select" | "combobox";
}) {
  const { m } = useI18n();
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? "");
  const selected = value ?? uncontrolled;
  const emptyLabel = placeholder ?? m.select.placeholder;
  const label = options.find((option) => option.value === selected)?.label ?? (selected || emptyLabel);
  const combobox = variant === "combobox" || (variant === "auto" && options.length >= LONG_LIST);

  function commit(next: string, form: HTMLFormElement | null): void {
    flushSync(() => {
      if (value === undefined) setUncontrolled(next);
      onValueChange?.(next);
    });
    if (submitOnChange) form?.requestSubmit();
  }

  const field = <input type="hidden" name={name} value={selected} />;
  if (combobox) {
    return (
      <FormCombobox
        id={controlId}
        label={label}
        selected={selected}
        options={options}
        disabled={disabled}
        className={className}
        onCommit={commit}
      >
        {field}
      </FormCombobox>
    );
  }
  return (
      <FormMenu
      id={controlId}
      label={label}
      selected={selected}
      options={options}
      disabled={disabled}
      className={className}
      onCommit={commit}
    >
      {field}
    </FormMenu>
  );
}

function FormMenu({
  id,
  label,
  selected,
  options,
  disabled,
  className,
  onCommit,
  children,
}: {
  id: string;
  label: string;
  selected: string;
  options: readonly FormSelectOption[];
  disabled: boolean;
  className?: string;
  onCommit: (value: string, form: HTMLFormElement | null) => void;
  children: ReactNode;
}) {
  return (
    <Select
      value={itemValue(selected)}
      onValueChange={(next) => onCommit(fieldValue(next), document.getElementById(id)?.closest("form") ?? null)}
      disabled={disabled}
    >
      {children}
      <SelectTrigger id={id} className={className} data-ui="select">
        <span className="truncate">{label}</span>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || EMPTY_ITEM} value={itemValue(option.value)}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FormCombobox({
  id,
  label,
  selected,
  options,
  disabled,
  className,
  onCommit,
  children,
}: {
  id: string;
  label: string;
  selected: string;
  options: readonly FormSelectOption[];
  disabled: boolean;
  className?: string;
  onCommit: (value: string, form: HTMLFormElement | null) => void;
  children: ReactNode;
}) {
  const { m } = useI18n();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const pointer = useRef<PointerPoint | null>(null);
  const frozenPointer = useRef<PointerPoint | null>(null);
  const filtered = filterOptions(options, query);
  const shown = Math.min(active, Math.max(0, filtered.length - 1));
  const shownOption = shown >= 0 ? filtered[shown] : undefined;

  useLayoutEffect(() => {
    if (!open || !shownOption) return;
    let frame = 0;
    let tries = 0;
    const reveal = () => {
      const list = document.getElementById(listId);
      const node = document.getElementById(optionId(id, shownOption.value));
      // The option list is portaled after this commit, so the first pass can run before it has a box.
      if (!list || !node || list.clientHeight <= 0) {
        if (tries++ < 8) frame = requestAnimationFrame(reveal);
        return;
      }
      const listRect = list.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const next = listScrollTopForOption(
        { scrollTop: list.scrollTop, clientHeight: list.clientHeight },
        { top: nodeRect.top - listRect.top + list.scrollTop, height: nodeRect.height },
      );
      if (next !== list.scrollTop) list.scrollTop = next;
    };
    reveal();
    return () => cancelAnimationFrame(frame);
  }, [open, shownOption, listId, id]);

  function choose(next: string): void {
    const form = document.getElementById(id)?.closest("form") ?? null;
    setOpen(false);
    setQuery("");
    onCommit(next, form);
  }

  function highlightFromKeyboard(next: number | ((current: number) => number)): void {
    frozenPointer.current = pointer.current;
    setActive(next);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery("");
          pointer.current = null;
          frozenPointer.current = null;
          const index = options.findIndex((option) => option.value === selected);
          setActive(index >= 0 ? index : 0);
        }
      }}
    >
      {children}
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          data-ui="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          disabled={disabled}
          className={cn(TRIGGER, className)}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="border-b p-1">
          <input
            aria-label={m.select.filter}
            aria-controls={listId}
            aria-activedescendant={shownOption ? optionId(id, shownOption.value) : undefined}
            className="h-8 w-full bg-transparent px-2 text-sm outline-none"
            value={query}
            placeholder={m.select.filter}
            onChange={(event) => {
              setQuery(event.target.value);
              highlightFromKeyboard(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                highlightFromKeyboard((current) => Math.min(filtered.length - 1, current + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                highlightFromKeyboard((current) => Math.max(0, current - 1));
              } else if (event.key === "Home") {
                event.preventDefault();
                highlightFromKeyboard(0);
              } else if (event.key === "End") {
                event.preventDefault();
                highlightFromKeyboard(Math.max(0, filtered.length - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (shownOption) choose(shownOption.value);
              }
            }}
          />
        </div>
        <ul id={listId} role="listbox" className="max-h-72 overflow-auto p-1">
          {filtered.length === 0 ? <li className="px-2 py-1.5 text-sm text-muted-foreground">{m.select.noMatches}</li> : null}
          {filtered.map((option, index) => {
            const on = option.value === selected;
            return (
              <li
                key={option.value || EMPTY_ITEM}
                id={optionId(id, option.value)}
                role="option"
                aria-selected={on}
                className={index === shown ? "flex cursor-default items-center rounded-sm bg-accent px-2 py-1.5 text-sm" : "flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm"}
                onPointerEnter={(event) => {
                  pointer.current = pointerPoint(event);
                }}
                onPointerMove={(event) => {
                  const point = pointerPoint(event);
                  const decision = activeIndexAfterPointerMove(index, point, frozenPointer.current);
                  pointer.current = point;
                  frozenPointer.current = decision.frozen;
                  if (decision.active !== null) setActive(decision.active);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(option.value)}
              >
                {option.label}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export type PointerPoint = { x: number; y: number };

/** Options sliding under a stationary pointer are not a hover. The highlight changes only after the pointer coordinates move. */
export function activeIndexAfterPointerMove(
  index: number,
  pointer: PointerPoint,
  frozen: PointerPoint | null,
): { active: number | null; frozen: PointerPoint | null } {
  if (frozen && frozen.x === pointer.x && frozen.y === pointer.y) return { active: null, frozen };
  return { active: index, frozen: null };
}

function pointerPoint(event: { clientX: number; clientY: number }): PointerPoint {
  return { x: event.clientX, y: event.clientY };
}

export function listScrollTopForOption(
  list: { scrollTop: number; clientHeight: number },
  option: { top: number; height: number },
): number {
  const optionBottom = option.top + option.height;
  const viewBottom = list.scrollTop + list.clientHeight;
  if (option.top < list.scrollTop) return option.top;
  if (optionBottom > viewBottom) return Math.max(0, optionBottom - list.clientHeight);
  return list.scrollTop;
}

function filterOptions(options: readonly FormSelectOption[], query: string): FormSelectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle));
}

function optionId(id: string, value: string): string {
  return `${id}-opt-${value || EMPTY_ITEM}`;
}

function itemValue(value: string): string {
  return value === "" ? EMPTY_ITEM : value;
}

function fieldValue(value: string): string {
  return value === EMPTY_ITEM ? "" : value;
}
