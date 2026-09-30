export type Template = 'booking-requested' | 'booking-confirmed' | 'booking-cancelled';

export interface Notification {
  readonly to: string;
  readonly template: Template;
  readonly bookingId: string;
}
