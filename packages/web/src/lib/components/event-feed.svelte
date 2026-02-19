<script lang="ts">
  import { ScrollArea } from '@ui/components/scroll-area/index';
  import EventCard from './event-card.svelte';
  import type { ZooidEvent } from '../api';

  let { events }: { events: ZooidEvent[] } = $props();

  let container: HTMLDivElement | undefined = $state();

  $effect(() => {
    // Auto-scroll to top when new events arrive (newest first)
    if (events.length > 0 && container) {
      container.scrollTop = 0;
    }
  });
</script>

<ScrollArea class="flex-1 px-4" bind:this={container}>
  {#if events.length === 0}
    <div class="flex items-center justify-center h-32 text-sm text-muted-foreground">
      No events yet. Waiting for signals...
    </div>
  {:else}
    <div class="flex flex-col gap-2 pb-4">
      {#each events as event (event.id)}
        <EventCard {event} />
      {/each}
    </div>
  {/if}
</ScrollArea>
