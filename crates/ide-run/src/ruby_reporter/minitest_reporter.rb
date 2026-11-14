# Written by OpenIDEA for test runs; registered by `openidea_test_hook.rb` once Minitest is loaded.
# Nothing in the project is changed.
#
# One record per line on stdout, which the IDE strips from the console again:
#   @@OPENIDEA@@{"t":"start","c":"MyTest","n":"test_x","f":"/abs/test.rb","l":12}
#   @@OPENIDEA@@{"t":"result","c":"MyTest","n":"test_x","s":"passed","d":0.001,"f":...,"l":...,"m":"failure text"}
#   @@OPENIDEA@@{"t":"summary","runs":7,"failures":1,"errors":1,"skips":1,"d":0.4}
require "json"

module Minitest
  class OpenIdeaReporter < AbstractReporter
    MARK = "@@OPENIDEA@@"

    def initialize(io)
      super()
      @io = io
      @cwd = Dir.pwd
      @lock = Mutex.new
      @runs = @failures = @errors = @skips = 0
      @started = nil
    end

    def start
      @started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    end

    def prerecord(klass, name)
      emit(t: "start", c: klass.to_s, n: name.to_s, **where(klass, name))
    end

    def record(result)
      @runs += 1
      status = result.skipped? ? "skipped" : result.passed? ? "passed" : "failed"
      @skips += 1 if status == "skipped"
      if status == "failed"
        result.failures.any? { |f| f.is_a?(UnexpectedError) } ? @errors += 1 : @failures += 1
      end
      loc = result.source_location
      emit(t: "result", c: result.klass.to_s, n: result.name.to_s, s: status, d: result.time,
           f: loc && absolute(loc[0]), l: loc && loc[1], m: result.failures.map(&:message).join("\n"))
    end

    def report
      d = @started ? Process.clock_gettime(Process::CLOCK_MONOTONIC) - @started : nil
      emit(t: "summary", runs: @runs, failures: @failures, errors: @errors, skips: @skips, d: d)
    end

    private

    # Where the test is defined, known before it runs (so the tree can show it while running).
    def where(klass, name)
      f, l = klass.instance_method(name).source_location
      { f: absolute(f), l: l }
    rescue StandardError
      {}
    end

    # Test files are often loaded by a path relative to the working directory.
    def absolute(file)
      File.expand_path(file, @cwd)
    end

    def emit(record)
      line = "#{MARK}#{JSON.generate(record)}\n"
      @lock.synchronize { @io.write(line) }
    rescue StandardError
      nil # reporting must never fail a test run
    end
  end

  def self.plugin_openidea_init(options)
    return unless ENV["OPENIDEA_TEST_REPORT"]

    io = options[:io] || $stdout
    io.sync = true if io.respond_to?(:sync=)
    reporter << OpenIdeaReporter.new(io)
  end
end
