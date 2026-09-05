/** Mirrors the Matrix Push Gateway API notify request body — the subset the gateway reads. */

export interface PushDevice {
  app_id: string
  pushkey: string
  data?: {
    endpoint?: string
    auth?: string
  }
  tweaks?: {
    sound?: string
  }
}

export interface PushNotification {
  event_id: string
  room_id: string
  room_name?: string
  sender_display_name?: string
  type: string
  content?: Record<string, unknown>
  counts?: { unread?: number }
  devices: PushDevice[]
}

export interface PushPayload {
  event_id: string
  room_id: string
  room_name: string
  sender_display_name?: string
  type: string
  body?: string
  unread: number
  sound: boolean
}
