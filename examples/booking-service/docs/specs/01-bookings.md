# 01. Bookings

## Requirements

### MONEY-1 Integer cents

All amounts are integer cents.

### MONEY-2 Half-even percentages

A percentage of an amount rounds half to even, through `percentOf`.

### PRICE-1 Peak pricing

A peak slot costs 20% more than its base price.

### CUST-1 Customers

Customers are registered and can be suspended; both are audited.

### BOOK-1 Request a booking

A customer requests a slot; the booking takes the slot's price and starts `requested`.

### BOOK-2 Confirm a booking

A slot holds at most one confirmed booking.

### BOOK-3 Cancel a booking

A requested or confirmed booking can be cancelled, recording the fee charged.

### BOOK-4 Cancellation fee

Cancelling a confirmed booking less than 24 hours before it starts charges 10% of its price.

### BOOK-5 Waiting list

When a confirmed booking is cancelled, the earliest requested booking for the same slot is confirmed.

### BOOK-6 Refunds

Cancelling returns the price minus the fee as the refund.

### BOOK-7 Discount codes

A discount code takes a percentage off a booking's price.

### BOOK-8 Booking limit

A customer holds at most three active bookings.

### NOTIFY-1 Notifications

Customers are notified of their bookings' events, in order.

### REPORT-1 Revenue

Revenue counts completed bookings and cancellation fees.

### API-1 Bookings over HTTP

Customers, slots and bookings over HTTP.

### API-2 One error shape

Errors are `{ error: { code, message } }` with the domain error code.

### API-3 Cancel over HTTP

Bookings are cancelled over HTTP.
