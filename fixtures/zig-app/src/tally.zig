//! Prices in cents, added up for the receipt.
const std = @import("std");

/// The sum of `prices`, in cents.
pub fn total(prices: []const u32) u32 {
    var sum: u32 = 0;
    for (prices) |price| sum += price;
    return sum;
}

/// `cents` as dollars and cents, e.g. `$134.97`.
pub fn format(buf: []u8, cents: u32) ![]u8 {
    // TODO: other currencies
    return std.fmt.bufPrint(buf, "${d}.{d:0>2}", .{ cents / 100, cents % 100 });
}

test "total adds the prices" {
    try std.testing.expectEqual(@as(u32, 13497), total(&.{ 4999, 2499, 5999 }));
}

test "total of nothing is zero" {
    try std.testing.expectEqual(@as(u32, 0), total(&.{}));
}

test "format pads the cents" {
    var buf: [16]u8 = undefined;
    try std.testing.expectEqualStrings("$1.05", try format(&buf, 105));
}
