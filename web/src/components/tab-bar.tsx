import { LiveBadge } from "@/components/shell-controls"
import { VIEWS, type ViewId } from "@/lib/views"

export function TabBar({ view, onView, live }: { view: ViewId; onView: (v: ViewId) => void; live: number }) {
  return (
    <nav
      aria-label="Views"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/90 pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] backdrop-blur lg:hidden"
    >
      <ul className="mx-auto grid h-14 max-w-md grid-cols-5">
        {VIEWS.map(({ id, label, short, icon: Icon }) => (
          <li key={id} className="contents">
            <button
              type="button"
              aria-current={view === id ? "page" : undefined}
              aria-label={label}
              onClick={() => onView(id)}
              className="group flex flex-col items-center justify-center gap-1 text-[11px] font-medium text-muted-foreground transition-colors duration-150 aria-[current=page]:text-foreground"
            >
              <span className="relative flex h-7 w-12 items-center justify-center rounded-md transition-colors duration-150 group-active:bg-foreground/[0.07] group-aria-[current=page]:bg-foreground/[0.08]">
                <Icon aria-hidden className="size-[18px]" strokeWidth={view === id ? 2 : 1.75} />
                {id === "now" ? <LiveBadge count={live} className="absolute -top-1 right-0 ring-2 ring-background" /> : null}
              </span>
              {short}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
