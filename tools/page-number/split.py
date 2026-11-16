"""Books held out of training to measure generalisation, by title substring.

Same works as the orientation model, plus two bottom-numbered books so the
held-out set also checks footer numbers (Western digits in بداية الهداية).
"""

TEST_WORKS = [
    "البلاغة",
    "السعدي",
    "رياض الصالحين",
    "القدوري",
    "الطحاوية",
    "الألفاظ الكتابية",
    "بداية الهداية",
    "القراءة الراشدة - الجزء الثالث",
]


def is_test(title: str) -> bool:
    return any(w in title for w in TEST_WORKS)
