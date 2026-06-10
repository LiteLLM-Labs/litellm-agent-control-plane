import { BrandIcon } from "@/components/brand-icons";
import { runtimeBrandIconId } from "@/lib/runtime-branding";

export function RuntimeProviderLogo({
  alias,
  apiSpec,
  className = "size-9",
  iconClassName = "size-5",
}: {
  alias: string;
  apiSpec?: string | null;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground shadow-sm ${className}`}
    >
      <BrandIcon id={runtimeBrandIconId(alias, apiSpec)} className={iconClassName} />
    </span>
  );
}
