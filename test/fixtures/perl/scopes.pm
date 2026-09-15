package Alpha;
sub same { 1 }
sub call_alpha { same() }
{
    package Beta;
    sub same { 2 }
    sub call_beta { same() }
}
sub after_block { same() }
package Gamma {
    sub same { 3 }
    sub call_gamma { same() }
}
sub final_alpha { same() }
package Alpha;
sub later;
sub later ($$) { 4 }
sub duplicate { 5 }
sub duplicate { 6 }
sub Other::entry { same() }
sub still_alpha { same() }
