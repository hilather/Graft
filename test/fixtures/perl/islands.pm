package Real;
my $one = q{package Fake; sub quoted { fake() }};
my $two = qq{package Fake; sub interpolated { fake() }};
my $re = qr/package Fake; sub regex { fake() }/;
my $nested = m{[{}]};
my ($first, $second) = (<<'FIRST', <<'SECOND');
package Fake; sub first_heredoc { fake() }
FIRST
package Fake; sub second_heredoc { fake() }
SECOND
=pod
package Fake; sub pod { fake() }
=cut
sub actual { 1 }
__DATA__
package Fake; sub data { fake() }
