import type { ComponentProps } from "react";
import { useRouter } from "./navigation";

export default function Link({ href, onClick, ...props }: ComponentProps<"a"> & { href: string }) {
  const router = useRouter();
  return <a {...props} href={href} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      router.push(href);
    }
  }} />;
}
