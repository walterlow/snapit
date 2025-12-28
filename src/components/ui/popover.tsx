import * as React from "react"
import { Popover as BasePopover } from "@base-ui/react/popover"
import { cn } from "@/lib/utils"

const Popover = BasePopover.Root

const PopoverTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof BasePopover.Trigger> & { asChild?: boolean }
>(({ className, asChild, children, ...props }, ref) => {
  if (asChild && React.isValidElement(children)) {
    return (
      <BasePopover.Trigger
        ref={ref}
        className={className}
        render={children}
        {...props}
      />
    )
  }
  return (
    <BasePopover.Trigger ref={ref} className={className} {...props}>
      {children}
    </BasePopover.Trigger>
  )
})
PopoverTrigger.displayName = "PopoverTrigger"

// PopoverAnchor not available in Base UI - alias to trigger for compatibility
const PopoverAnchor = PopoverTrigger

interface PopoverContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: "start" | "center" | "end"
  sideOffset?: number
  side?: "top" | "right" | "bottom" | "left"
}

const PopoverContent = React.forwardRef<HTMLDivElement, PopoverContentProps>(
  ({ className, align = "center", sideOffset = 4, side = "bottom", ...props }, ref) => (
    <BasePopover.Portal>
      <BasePopover.Positioner side={side} sideOffset={sideOffset} align={align} className="z-[200]">
        <BasePopover.Popup
          ref={ref}
          className={cn(
            "z-[200] w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none",
            className
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
)
PopoverContent.displayName = "PopoverContent"

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor }
