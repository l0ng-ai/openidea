const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const tally = b.addModule("tally", .{
        .root_source_file = b.path("src/tally.zig"),
        .target = target,
    });

    const exe = b.addExecutable(.{
        .name = "zig-app",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{ .name = "tally", .module = tally }},
        }),
    });
    b.installArtifact(exe);

    const run_cmd = b.addRunArtifact(exe);
    run_cmd.step.dependOn(b.getInstallStep());
    const run_step = b.step("run", "Run the app");
    run_step.dependOn(&run_cmd.step);

    const tests = b.addTest(.{ .root_module = tally });
    const test_step = b.step("test", "Run the tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
