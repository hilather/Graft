package Scope;
sub helper { 1 }
sub outer {
    helper();
    {
        my sub helper { 2 }
        helper();
        state sub memo { 3 }
        memo();
        my $handler = sub { helper() };
        $handler->();
        &$handler();
        $handler = unknown();
        $handler->();
    }
    helper();
    our sub helper;
    \&Scope::helper;
    &helper;
    callback(sub { helper() });
}
