CFLAGS = -g -O0 -std=c11
CXXFLAGS = -g -O0 -std=c++17

.PHONY: all app-c app-cpp clean

all: app-c app-cpp

app-c: bin
	$(CC) $(CFLAGS) -o bin/app-c src/main.c

app-cpp: bin
	$(CXX) $(CXXFLAGS) -o bin/app-cpp src/main.cpp

bin:
	mkdir -p bin

clean:
	rm -rf bin
