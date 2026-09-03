package main

import "fmt"

// Deliberately broken: a string where an int belongs. `go build ./...` must
// refuse this — that refusal is what the fixture exists to prove.
func Add(a int, b int) int {
	return "not an int"
}

func main() {
	fmt.Println(Add(1, 2))
}
