// Deliberately broken: a String returned where an int is declared. `javac`
// must refuse this — that refusal is what the fixture exists to prove.
public class Main {
    static int add(int a, int b) {
        return "not an int";
    }

    public static void main(String[] args) {
        System.out.println(add(1, 2));
    }
}
