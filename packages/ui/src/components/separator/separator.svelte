<script lang="ts">
  import { cn } from '../../lib/utils';
  import type { HTMLAttributes } from 'svelte/elements';

  let {
    class: className,
    orientation = 'horizontal',
    ...restProps
  }: HTMLAttributes<HTMLDivElement> & {
    orientation?: 'horizontal' | 'vertical';
  } = $props();
</script>

<div
  role="separator"
  aria-orientation={orientation}
  class={cn(
    'shrink-0 bg-border',
    orientation === 'horizontal' ? 'h-[1px] w-full' : 'h-full w-[1px]',
    className,
  )}
  {...restProps}
></div>
