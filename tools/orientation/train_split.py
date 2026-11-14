"""Works held out of training to measure generalisation (any edition), by title substring."""

TEST_WORKS = ["البلاغة", "السعدي", "رياض الصالحين", "القدوري", "الطحاوية", "الألفاظ الكتابية"]


def is_test(title: str) -> bool:
    return any(w in title for w in TEST_WORKS)
