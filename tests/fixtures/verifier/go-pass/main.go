package main

import "fmt"

// Add is the whole fixture: enough for `go build` and `go test` to mean something.
func Add(a int, b int) int {
	return a + b
}

func main() {
	fmt.Println(Add(1, 2))
}
