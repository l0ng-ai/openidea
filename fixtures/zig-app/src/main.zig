const std = @import("std");
const tally = @import("tally");

pub fn main() !void {
    const prices = [_]u32{ 4999, 2499, 5999 };
    const sum = tally.total(&prices); // Set a breakpoint here
    var buf: [16]u8 = undefined;
    std.debug.print("Total: {s}\n", .{try tally.format(&buf, sum)});
}
