# Deliberately broken: the def line has no colon, so this file does not
# compile. `python -m py_compile calc.py` must refuse it — that refusal is
# what the fixture exists to prove.
def add(a, b)
    return a + b
