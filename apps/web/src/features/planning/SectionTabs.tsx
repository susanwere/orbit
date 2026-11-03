import type { ReactNode } from "react";
import "./section-tabs.css";

interface SectionTab<Key extends string> {
  readonly key: Key;
  readonly title: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
}

export function SectionTabs<Key extends string>({
  items,
  selectedKey,
  onSelect,
  label,
  idPrefix,
}: {
  readonly items: readonly SectionTab<Key>[];
  readonly selectedKey: Key;
  readonly onSelect: (key: Key) => void;
  readonly label: string;
  readonly idPrefix: string;
}) {
  const enabled = items.filter((item) => !item.disabled);
  return (
    <div className="workspace-section-tabs" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${item.key}`}
          aria-selected={selectedKey === item.key}
          aria-controls={`${idPrefix}-panel-${item.key}`}
          tabIndex={selectedKey === item.key ? 0 : -1}
          disabled={item.disabled}
          onClick={() => onSelect(item.key)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = enabled.findIndex((entry) => entry.key === item.key);
            const nextIndex =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? enabled.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) %
                    enabled.length;
            const nextTab = enabled[nextIndex];
            if (!nextTab) return;
            onSelect(nextTab.key);
            document.getElementById(`${idPrefix}-tab-${nextTab.key}`)?.focus();
          }}
        >
          {item.icon}
          {item.title}
        </button>
      ))}
    </div>
  );
}
